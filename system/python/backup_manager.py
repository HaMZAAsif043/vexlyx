#!/usr/bin/env python3
"""
backup_manager.py -- System-layer script for Vexlyx's full-system backup
system (F5.3).

Archives project source trees, dumps databases (via docker exec), and tars
mail domain vhosts subtrees into one gzip archive per snapshot under
BACKUPS_DIR. Also supports extracting/restoring a single item back out of a
previously created archive.

Called by the Fastify API via child_process.spawn with a JSON payload on
stdin. Writes JSON results (and progress "log" lines) to stdout, exits with
code 0 on success, 1 on error.

Commands:
  create_snapshot  -- Archives projects, database dumps, and mail domains
                       named in the payload into one <snapshotId>.tar.gz.
  restore_item      -- Extracts and restores a single item from a snapshot
                       archive (project files, a database dump, or a mail
                       domain's vhosts subtree).
  delete_archive     -- Removes a snapshot's archive file from disk.
"""

import gzip
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
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
# Helpers (mirrors database_manager.py / docker_manager.py conventions)
# ---------------------------------------------------------------------------


def respond(data: dict) -> None:
    print(json.dumps(data), flush=True)


def log_line(message: str) -> None:
    print(json.dumps({"log": message}), flush=True)


def fail(message: str, code: str = "BACKUP_ERROR") -> None:
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)


def require_field(payload: dict, field: str):
    value = payload.get(field)
    if value is None:
        fail(f"Missing required field: {field}", "INVALID_PAYLOAD")
    return value


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
    """Validate database/domain identifiers to prevent SQL/shell injection."""
    if not re.match(r"^[a-zA-Z0-9_.-]{1,63}$", name):
        fail(
            f"Invalid {field_name} '{name}'. Must be 1-63 alphanumeric, underscore, dot, or hyphen characters.",
            "INVALID_IDENTIFIER",
        )
    return name


def popen_docker_exec(
    container_name: str,
    cmd_args: list[str],
    env_vars: dict[str, str] | None = None,
    needs_stdin: bool = False,
) -> subprocess.Popen:
    """Spawn `docker exec` in binary mode with piped stdout (and optionally
    stdin), for streaming large database dumps through gzip without
    buffering the whole thing in memory."""
    docker_bin = get_docker_binary()
    full_cmd = [docker_bin, "exec", "-i"]
    if env_vars:
        for k, v in env_vars.items():
            full_cmd.extend(["-e", f"{k}={v}"])
    full_cmd.append(container_name)
    full_cmd.extend(cmd_args)

    return subprocess.Popen(
        full_cmd,
        stdin=subprocess.PIPE if needs_stdin else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def get_vhosts_dir() -> Path:
    candidates = [
        Path.cwd() / "docker" / "mail-data" / "vhosts",
        Path.cwd().parent / "docker" / "mail-data" / "vhosts",
        Path.cwd().parent.parent / "docker" / "mail-data" / "vhosts",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


def get_backups_dir(payload: dict) -> Path:
    backups_dir = Path(require_field(payload, "backupsDir"))
    backups_dir.mkdir(parents=True, exist_ok=True)
    return backups_dir


def sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# create_snapshot
# ---------------------------------------------------------------------------


def dump_database(staging_dir: Path, db: dict) -> dict:
    db_id = validate_identifier(require_field(db, "id"), "database id")
    db_name = validate_identifier(require_field(db, "name"), "dbName")
    engine = require_field(db, "type")
    container = db.get("container") or (
        "vexlyx-postgres" if engine == "POSTGRESQL" else "vexlyx-mysql"
    )

    dest = staging_dir / "databases" / f"{db_id}.sql.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)

    log_line(f"Dumping database {db_name} ({engine})...")

    if engine == "POSTGRESQL":
        db_user = validate_identifier(require_field(db, "dbUser"), "dbUser")
        proc = popen_docker_exec(
            container,
            ["pg_dump", "-U", db_user, "--clean", "--if-exists", db_name],
            env_vars={"PGPASSWORD": require_field(db, "dbPassword")},
        )
    elif engine == "MYSQL":
        db_user = require_field(db, "dbUser")
        db_password = require_field(db, "dbPassword")
        proc = popen_docker_exec(
            container,
            ["mysqldump", f"-u{db_user}", f"-p{db_password}", "--add-drop-table", db_name],
        )
    else:
        fail(f"Unsupported database engine: {engine}", "UNSUPPORTED_ENGINE")
        return {}

    with gzip.open(dest, "wb") as gz_out:
        for chunk in iter(lambda: proc.stdout.read(1024 * 1024), b""):
            gz_out.write(chunk)

    _, stderr = proc.communicate()
    rc = proc.returncode

    if rc != 0:
        dest.unlink(missing_ok=True)
        stderr_text = stderr.decode("utf-8", errors="replace") if stderr else ""
        fail(f"Failed to dump database '{db_name}': {stderr_text.strip()}", "DB_DUMP_FAILED")

    return {
        "id": db_id,
        "name": db_name,
        "type": engine,
        "sizeBytes": dest.stat().st_size,
        "checksum": sha256_of_file(dest),
    }


def archive_project(staging_dir: Path, project: dict) -> dict:
    project_id = validate_identifier(require_field(project, "id"), "project id")
    name = require_field(project, "name")
    source_path = Path(require_field(project, "path"))

    dest = staging_dir / "projects" / f"{project_id}.tar.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)

    if not source_path.exists():
        log_line(f"Skipping project {name}: workspace directory not found")
        with tarfile.open(dest, "w:gz"):
            pass
    else:
        log_line(f"Archiving project {name}...")
        with tarfile.open(dest, "w:gz") as tar:
            tar.add(source_path, arcname=".")

    return {
        "id": project_id,
        "name": name,
        "sizeBytes": dest.stat().st_size,
        "checksum": sha256_of_file(dest),
    }


def archive_mail_domain(staging_dir: Path, mail: dict) -> dict:
    domain_id = validate_identifier(require_field(mail, "domainId"), "domain id")
    hostname = validate_identifier(require_field(mail, "hostname"), "hostname")

    source_path = get_vhosts_dir() / hostname
    dest = staging_dir / "mail" / f"{domain_id}.tar.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)

    if not source_path.exists():
        log_line(f"Skipping mail domain {hostname}: no vhosts directory")
        with tarfile.open(dest, "w:gz"):
            pass
    else:
        log_line(f"Archiving mail domain {hostname}...")
        with tarfile.open(dest, "w:gz") as tar:
            tar.add(source_path, arcname=".")

    return {
        "domainId": domain_id,
        "hostname": hostname,
        "sizeBytes": dest.stat().st_size,
        "checksum": sha256_of_file(dest),
    }


def cmd_create_snapshot(payload: dict) -> None:
    snapshot_id = validate_identifier(require_field(payload, "snapshotId"), "snapshot id")
    backups_dir = get_backups_dir(payload)
    staging_dir = backups_dir / snapshot_id

    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True)

    manifest = {
        "projects": [archive_project(staging_dir, p) for p in payload.get("projects", [])],
        "databases": [dump_database(staging_dir, d) for d in payload.get("databases", [])],
        "mail": [archive_mail_domain(staging_dir, m) for m in payload.get("mail", [])],
        # DNS records are handed to us pre-serialized (Postgres is their
        # source of truth) — just written verbatim into the manifest file.
        "dns": payload.get("dns", []),
    }

    manifest_path = staging_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    archive_path = backups_dir / f"{snapshot_id}.tar.gz"
    log_line("Compressing snapshot archive...")
    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(staging_dir, arcname=".")

    shutil.rmtree(staging_dir)

    respond(
        {
            "success": True,
            "archivePath": str(archive_path),
            "sizeBytes": archive_path.stat().st_size,
            "manifest": manifest,
        }
    )


# ---------------------------------------------------------------------------
# restore_item
# ---------------------------------------------------------------------------


def _normalize_member_name(name: str) -> str:
    # The outer snapshot archive is built with arcname=".", so member names
    # come out as "./projects/<id>.tar.gz" rather than "projects/<id>.tar.gz".
    return name[2:] if name.startswith("./") else name


def extract_members(archive_path: Path, prefix: str, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as tar:
        for member in tar.getmembers():
            name = _normalize_member_name(member.name)
            if name == prefix or name.startswith(prefix + "/"):
                member.name = name
                tar.extract(member, dest_dir)


def restore_project(payload: dict, archive_path: Path) -> dict:
    item_id = validate_identifier(require_field(payload, "itemId"), "project id")
    target_path = Path(require_field(payload, "targetPath"))

    tmp_dir = archive_path.parent / f"_restore_{item_id}"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)

    log_line("Extracting project archive...")
    extract_members(archive_path, f"projects/{item_id}.tar.gz", tmp_dir)
    project_tar = tmp_dir / "projects" / f"{item_id}.tar.gz"
    if not project_tar.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
        fail(f"Project '{item_id}' not found in this snapshot", "ITEM_NOT_IN_SNAPSHOT")

    log_line("Restoring project files...")
    if target_path.exists():
        shutil.rmtree(target_path)
    target_path.mkdir(parents=True)
    with tarfile.open(project_tar, "r:gz") as tar:
        tar.extractall(target_path)

    shutil.rmtree(tmp_dir, ignore_errors=True)
    return {"success": True, "restored": "project", "itemId": item_id}


def restore_database(payload: dict, archive_path: Path) -> dict:
    item_id = validate_identifier(require_field(payload, "itemId"), "database id")
    db_name = validate_identifier(require_field(payload, "dbName"), "dbName")
    engine = require_field(payload, "dbType")
    container = payload.get("container") or (
        "vexlyx-postgres" if engine == "POSTGRESQL" else "vexlyx-mysql"
    )

    tmp_dir = archive_path.parent / f"_restore_{item_id}"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)

    log_line("Extracting database dump...")
    extract_members(archive_path, f"databases/{item_id}.sql.gz", tmp_dir)
    dump_file = tmp_dir / "databases" / f"{item_id}.sql.gz"
    if not dump_file.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
        fail(f"Database '{item_id}' not found in this snapshot", "ITEM_NOT_IN_SNAPSHOT")

    log_line(f"Restoring database {db_name}...")

    if engine == "POSTGRESQL":
        db_user = validate_identifier(require_field(payload, "dbUser"), "dbUser")
        proc = popen_docker_exec(
            container,
            ["psql", "-U", db_user, "-d", db_name, "-v", "ON_ERROR_STOP=0"],
            env_vars={"PGPASSWORD": require_field(payload, "dbPassword")},
            needs_stdin=True,
        )
    elif engine == "MYSQL":
        db_user = require_field(payload, "dbUser")
        db_password = require_field(payload, "dbPassword")
        proc = popen_docker_exec(
            container,
            ["mysql", f"-u{db_user}", f"-p{db_password}", db_name],
            needs_stdin=True,
        )
    else:
        fail(f"Unsupported database engine: {engine}", "UNSUPPORTED_ENGINE")
        return {}

    with gzip.open(dump_file, "rb") as gz_in:
        for chunk in iter(lambda: gz_in.read(1024 * 1024), b""):
            proc.stdin.write(chunk)

    proc.stdin.close()
    _, stderr = proc.communicate()
    rc = proc.returncode

    shutil.rmtree(tmp_dir, ignore_errors=True)

    if rc != 0:
        stderr_text = stderr.decode("utf-8", errors="replace") if stderr else ""
        fail(f"Failed to restore database '{db_name}': {stderr_text.strip()}", "DB_RESTORE_FAILED")

    return {"success": True, "restored": "database", "itemId": item_id}


def restore_mail(payload: dict, archive_path: Path) -> dict:
    domain_id = validate_identifier(require_field(payload, "itemId"), "domain id")
    hostname = validate_identifier(require_field(payload, "hostname"), "hostname")

    tmp_dir = archive_path.parent / f"_restore_{domain_id}"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)

    log_line("Extracting mail domain archive...")
    extract_members(archive_path, f"mail/{domain_id}.tar.gz", tmp_dir)
    mail_tar = tmp_dir / "mail" / f"{domain_id}.tar.gz"
    if not mail_tar.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
        fail(f"Mail domain '{domain_id}' not found in this snapshot", "ITEM_NOT_IN_SNAPSHOT")

    target_path = get_vhosts_dir() / hostname
    log_line(f"Restoring mailboxes for {hostname}...")
    if target_path.exists():
        shutil.rmtree(target_path)
    target_path.mkdir(parents=True)
    with tarfile.open(mail_tar, "r:gz") as tar:
        tar.extractall(target_path)

    shutil.rmtree(tmp_dir, ignore_errors=True)

    # Fix ownership inside the container, mirroring dovecot_manager.py's
    # post-write chown fix (mail data is a host bind mount).
    container_path = f"/var/mail/vhosts/{hostname}"
    subprocess.run(
        ["docker", "exec", "vexlyx-dovecot", "chown", "-R", "5000:5000", container_path],
        capture_output=True,
        timeout=120,
    )

    return {"success": True, "restored": "mail", "itemId": domain_id}


def cmd_restore_item(payload: dict) -> None:
    archive_path = Path(require_field(payload, "archivePath"))
    if not archive_path.exists():
        fail("Snapshot archive not found on disk", "ARCHIVE_NOT_FOUND")

    item_type = require_field(payload, "itemType")
    if item_type == "project":
        res = restore_project(payload, archive_path)
    elif item_type == "database":
        res = restore_database(payload, archive_path)
    elif item_type == "mail":
        res = restore_mail(payload, archive_path)
    else:
        fail(f"Unsupported restore item type: {item_type}", "UNSUPPORTED_ITEM_TYPE")
        return
    respond(res)


# ---------------------------------------------------------------------------
# delete_archive
# ---------------------------------------------------------------------------


def cmd_delete_archive(payload: dict) -> None:
    archive_path = Path(require_field(payload, "archivePath"))
    if archive_path.exists():
        archive_path.unlink()
    respond({"success": True, "deleted": str(archive_path)})


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

COMMANDS = {
    "create_snapshot": cmd_create_snapshot,
    "restore_item": cmd_restore_item,
    "delete_archive": cmd_delete_archive,
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

    try:
        COMMANDS[command](payload)
    except subprocess.TimeoutExpired as exc:
        fail(f"Command timed out after {exc.timeout}s", "COMMAND_TIMEOUT")


if __name__ == "__main__":
    main()
