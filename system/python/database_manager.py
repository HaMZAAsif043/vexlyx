#!/usr/bin/env python3
"""
database_manager.py -- System-layer script for Vexlyx database provisioning (F2.6).

Manages PostgreSQL and MySQL databases, users, permissions, and connections
inside Docker engine containers.

Called by the Fastify API via child_process.spawn with a JSON payload on stdin.
Writes JSON results to stdout and exits with code 0 on success, 1 on error.

Commands:
  create_database   -- Creates isolated database, user, and grants privileges.
  delete_database   -- Drops database, terminates connections, and removes user.
  test_connection   -- Tests connectivity to the database with the provided credentials.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# Stream encoding
# ---------------------------------------------------------------------------

if hasattr(sys.stdin, "reconfigure"):
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def respond(data: dict) -> None:
    print(json.dumps(data), flush=True)


def log_line(message: str) -> None:
    print(json.dumps({"log": message}), flush=True)


def fail(message: str, code: str = "DATABASE_ERROR") -> None:
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)


def require_field(payload: dict, field: str) -> str:
    value = payload.get(field)
    if value is None or not isinstance(value, (str, int)):
        fail(f"Missing required field: {field}", "INVALID_PAYLOAD")
    return str(value)


def get_docker_binary() -> str:
    binary = shutil.which("docker")
    if binary:
        return binary
    fail(
        "Docker CLI not found in PATH. Make sure Docker Engine/Desktop is running.",
        "DOCKER_NOT_FOUND",
    )
    return "docker"


def validate_identifier(name: str, field_name: str = "identifier") -> str:
    """Validate database or user name to prevent SQL injection."""
    if not re.match(r"^[a-zA-Z0-9_.-]{1,63}$", name):
        fail(
            f"Invalid {field_name} '{name}'. Must be 1-63 alphanumeric, underscore, dot, or hyphen characters.",
            "INVALID_IDENTIFIER",
        )
    return name


def escape_sql_string(val: str) -> str:
    """Escape single quotes for SQL string literals."""
    return val.replace("'", "''").replace("\\", "\\\\")


# Seconds. Provisioning commands are quick; a hung engine must not hang us.
DOCKER_EXEC_TIMEOUT = 120


def run_docker_exec(
    container_name: str,
    cmd_args: list[str],
    input_text: str | None = None,
    env_vars: dict[str, str] | None = None,
    timeout: int = DOCKER_EXEC_TIMEOUT,
) -> tuple[int, str, str]:
    """Execute command inside a docker container, bounded by `timeout` seconds."""
    docker_bin = get_docker_binary()
    full_cmd = [docker_bin, "exec", "-i"]
    if env_vars:
        for k, v in env_vars.items():
            full_cmd.extend(["-e", f"{k}={v}"])
    full_cmd.append(container_name)
    full_cmd.extend(cmd_args)

    group = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    proc = subprocess.Popen(
        full_cmd,
        stdin=subprocess.PIPE if input_text is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **group,
    )
    try:
        stdout, stderr = proc.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        # Kill the whole group: the `docker exec` client and anything it spawned
        # must not keep running (or holding our pipes) after we give up.
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                    capture_output=True,
                    timeout=15,
                )
            else:
                os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            proc.kill()
        proc.communicate()
        fail(
            f"`docker exec {container_name}` timed out after {timeout}s",
            "COMMAND_TIMEOUT",
        )
    return proc.returncode, stdout, stderr


# ---------------------------------------------------------------------------
# PostgreSQL Handlers
# ---------------------------------------------------------------------------


def postgres_create_database(payload: dict) -> dict:
    container = payload.get("containerName", "vexlyx-postgres")
    db_name = validate_identifier(require_field(payload, "dbName"), "dbName")
    db_user = validate_identifier(require_field(payload, "dbUser"), "dbUser")
    db_password = require_field(payload, "dbPassword")
    root_user = payload.get("rootUser", "vexlyx")
    admin_db = payload.get("adminDb", "vexlyx_dev")

    escaped_pw = escape_sql_string(db_password)

    # 1. Create or update user
    sql_user = f"""
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '{db_user}') THEN
            CREATE ROLE "{db_user}" WITH LOGIN PASSWORD '{escaped_pw}';
        ELSE
            ALTER ROLE "{db_user}" WITH PASSWORD '{escaped_pw}';
        END IF;
    END
    $$;
    """
    rc, stdout, stderr = run_docker_exec(
        container,
        ["psql", "-U", root_user, "-d", admin_db, "-v", "ON_ERROR_STOP=1"],
        input_text=sql_user,
    )
    if rc != 0:
        fail(f"Failed to create/update PostgreSQL user: {stderr.strip() or stdout.strip()}", "PG_USER_CREATE_FAILED")

    # 2. Check if database exists; if not, create it
    check_sql = f"SELECT 1 FROM pg_database WHERE datname = '{db_name}';"
    rc, stdout, stderr = run_docker_exec(
        container,
        ["psql", "-U", root_user, "-d", admin_db, "-tAc", check_sql],
    )
    if rc != 0:
        fail(f"Failed to query PostgreSQL database existence: {stderr.strip()}", "PG_QUERY_FAILED")

    if stdout.strip() != "1":
        # Create database
        create_sql = f'CREATE DATABASE "{db_name}" OWNER "{db_user}";'
        rc, stdout, stderr = run_docker_exec(
            container,
            ["psql", "-U", root_user, "-d", admin_db, "-c", create_sql],
        )
        if rc != 0:
            fail(f"Failed to create PostgreSQL database: {stderr.strip()}", "PG_DB_CREATE_FAILED")

    # 3. Grant privileges on the new database & schema
    grant_db_sql = f"""
    GRANT ALL PRIVILEGES ON DATABASE "{db_name}" TO "{db_user}";
    """
    run_docker_exec(
        container,
        ["psql", "-U", root_user, "-d", admin_db, "-c", grant_db_sql],
    )

    grant_schema_sql = f"""
    GRANT ALL ON SCHEMA public TO "{db_user}";
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "{db_user}";
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "{db_user}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "{db_user}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "{db_user}";
    """
    run_docker_exec(
        container,
        ["psql", "-U", root_user, "-d", db_name, "-c", grant_schema_sql],
    )

    return {
        "success": True,
        "engine": "POSTGRESQL",
        "database": db_name,
        "user": db_user,
        "container": container,
    }


def postgres_delete_database(payload: dict) -> dict:
    container = payload.get("containerName", "vexlyx-postgres")
    db_name = validate_identifier(require_field(payload, "dbName"), "dbName")
    db_user = validate_identifier(payload.get("dbUser", ""), "dbUser") if payload.get("dbUser") else None
    root_user = payload.get("rootUser", "vexlyx")
    admin_db = payload.get("adminDb", "vexlyx_dev")

    # 1. Terminate all active connections to the database
    terminate_sql = f"""
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '{db_name}' AND pid <> pg_backend_pid();
    """
    run_docker_exec(
        container,
        ["psql", "-U", root_user, "-d", admin_db, "-c", terminate_sql],
    )

    # 2. Drop database
    drop_db_sql = f'DROP DATABASE IF EXISTS "{db_name}";'
    rc, stdout, stderr = run_docker_exec(
        container,
        ["psql", "-U", root_user, "-d", admin_db, "-c", drop_db_sql],
    )
    if rc != 0:
        fail(f"Failed to drop PostgreSQL database: {stderr.strip()}", "PG_DROP_DB_FAILED")

    # 3. Drop user if specified
    if db_user:
        drop_user_sql = f'DROP ROLE IF EXISTS "{db_user}";'
        run_docker_exec(
            container,
            ["psql", "-U", root_user, "-d", admin_db, "-c", drop_user_sql],
        )

    return {
        "success": True,
        "droppedDatabase": db_name,
        "droppedUser": db_user,
    }


def postgres_test_connection(payload: dict) -> dict:
    container = payload.get("containerName", "vexlyx-postgres")
    db_name = validate_identifier(require_field(payload, "dbName"), "dbName")
    db_user = validate_identifier(require_field(payload, "dbUser"), "dbUser")
    db_password = require_field(payload, "dbPassword")

    start_t = time.perf_counter()
    rc, stdout, stderr = run_docker_exec(
        container,
        ["psql", "-U", db_user, "-d", db_name, "-tAc", "SELECT 1;"],
        env_vars={"PGPASSWORD": db_password},
    )
    latency_ms = round((time.perf_counter() - start_t) * 1000, 2)

    if rc != 0 or stdout.strip() != "1":
        return {
            "connected": False,
            "error": stderr.strip() or stdout.strip() or "Connection failed",
            "latencyMs": latency_ms,
        }

    return {
        "connected": True,
        "latencyMs": latency_ms,
        "database": db_name,
        "user": db_user,
    }


# ---------------------------------------------------------------------------
# MySQL Handlers
# ---------------------------------------------------------------------------


def mysql_create_database(payload: dict) -> dict:
    container = payload.get("containerName", "vexlyx-mysql")
    db_name = validate_identifier(require_field(payload, "dbName"), "dbName")
    db_user = validate_identifier(require_field(payload, "dbUser"), "dbUser")
    db_password = require_field(payload, "dbPassword")
    root_user = payload.get("rootUser", "root")
    root_password = payload.get("rootPassword", "vexlyx_mysql_root")

    escaped_pw = escape_sql_string(db_password)

    sql_statements = f"""
    CREATE DATABASE IF NOT EXISTS `{db_name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS '{db_user}'@'%' IDENTIFIED BY '{escaped_pw}';
    ALTER USER '{db_user}'@'%' IDENTIFIED BY '{escaped_pw}';
    GRANT ALL PRIVILEGES ON `{db_name}`.* TO '{db_user}'@'%';
    FLUSH PRIVILEGES;
    """

    rc, stdout, stderr = run_docker_exec(
        container,
        ["mysql", f"-u{root_user}", f"-p{root_password}"],
        input_text=sql_statements,
    )
    if rc != 0:
        # Filter standard CLI password warning
        err_lines = [l for l in stderr.splitlines() if "Using a password on the command line interface can be insecure" not in l]
        if err_lines:
            fail(f"Failed to create MySQL database/user: {' '.join(err_lines)}", "MYSQL_PROVISION_FAILED")

    return {
        "success": True,
        "engine": "MYSQL",
        "database": db_name,
        "user": db_user,
        "container": container,
    }


def mysql_delete_database(payload: dict) -> dict:
    container = payload.get("containerName", "vexlyx-mysql")
    db_name = validate_identifier(require_field(payload, "dbName"), "dbName")
    db_user = validate_identifier(payload.get("dbUser", ""), "dbUser") if payload.get("dbUser") else None
    root_user = payload.get("rootUser", "root")
    root_password = payload.get("rootPassword", "vexlyx_mysql_root")

    sql_statements = f"DROP DATABASE IF EXISTS `{db_name}`;\n"
    if db_user:
        sql_statements += f"DROP USER IF EXISTS '{db_user}'@'%';\n"
    sql_statements += "FLUSH PRIVILEGES;\n"

    rc, stdout, stderr = run_docker_exec(
        container,
        ["mysql", f"-u{root_user}", f"-p{root_password}"],
        input_text=sql_statements,
    )
    if rc != 0:
        err_lines = [l for l in stderr.splitlines() if "Using a password on the command line interface can be insecure" not in l]
        if err_lines:
            fail(f"Failed to drop MySQL database/user: {' '.join(err_lines)}", "MYSQL_DROP_FAILED")

    return {
        "success": True,
        "droppedDatabase": db_name,
        "droppedUser": db_user,
    }


def mysql_test_connection(payload: dict) -> dict:
    container = payload.get("containerName", "vexlyx-mysql")
    db_name = validate_identifier(require_field(payload, "dbName"), "dbName")
    db_user = validate_identifier(require_field(payload, "dbUser"), "dbUser")
    db_password = require_field(payload, "dbPassword")

    start_t = time.perf_counter()
    rc, stdout, stderr = run_docker_exec(
        container,
        ["mysql", f"-u{db_user}", f"-p{db_password}", "-D", db_name, "-e", "SELECT 1;"],
    )
    latency_ms = round((time.perf_counter() - start_t) * 1000, 2)

    err_lines = [l for l in stderr.splitlines() if "Using a password on the command line interface can be insecure" not in l]

    if rc != 0 and err_lines:
        return {
            "connected": False,
            "error": " ".join(err_lines) or stdout.strip() or "Connection failed",
            "latencyMs": latency_ms,
        }

    return {
        "connected": True,
        "latencyMs": latency_ms,
        "database": db_name,
        "user": db_user,
    }


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def cmd_create_database(payload: dict) -> None:
    engine = require_field(payload, "engine").upper()
    if engine in ("POSTGRESQL", "POSTGRES"):
        res = postgres_create_database(payload)
    elif engine in ("MYSQL", "MARIADB"):
        res = mysql_create_database(payload)
    else:
        fail(f"Unsupported database engine: {engine}. Use POSTGRESQL or MYSQL.", "UNSUPPORTED_ENGINE")
        return
    respond(res)


def cmd_delete_database(payload: dict) -> None:
    engine = require_field(payload, "engine").upper()
    if engine in ("POSTGRESQL", "POSTGRES"):
        res = postgres_delete_database(payload)
    elif engine in ("MYSQL", "MARIADB"):
        res = mysql_delete_database(payload)
    else:
        fail(f"Unsupported database engine: {engine}. Use POSTGRESQL or MYSQL.", "UNSUPPORTED_ENGINE")
        return
    respond(res)


def cmd_test_connection(payload: dict) -> None:
    engine = require_field(payload, "engine").upper()
    if engine in ("POSTGRESQL", "POSTGRES"):
        res = postgres_test_connection(payload)
    elif engine in ("MYSQL", "MARIADB"):
        res = mysql_test_connection(payload)
    else:
        fail(f"Unsupported database engine: {engine}. Use POSTGRESQL or MYSQL.", "UNSUPPORTED_ENGINE")
        return
    respond(res)


COMMANDS = {
    "create_database": cmd_create_database,
    "delete_database": cmd_delete_database,
    "test_connection": cmd_test_connection,
}


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        fail("No input received on stdin", "NO_INPUT")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Invalid JSON payload: {exc}", "INVALID_JSON")
        return

    command = payload.get("command")
    if command not in COMMANDS:
        fail(
            f"Unknown command '{command}'. Valid: {', '.join(COMMANDS)}",
            "UNKNOWN_COMMAND",
        )
        return

    COMMANDS[command](payload)


if __name__ == "__main__":
    main()
