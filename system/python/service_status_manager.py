#!/usr/bin/env python3
"""
service_status_manager.py -- Vexlyx service status dashboard (F5.6).

Called by the API service via child_process.spawn with a JSON payload on
stdin. Writes JSON results to stdout and exits with code 0 on success, 1 on
error. Same "Docker-outside-of-Docker" pattern as docker_manager.py /
system_monitor.py -- the API container has the host Docker socket bind
mounted, so plain `docker` CLI calls here reach the real host containers.

Every managed service in Vexlyx (Postfix, Dovecot, CoreDNS, PostgreSQL,
Redis) runs as its own Docker container, so start/stop/restart/status/logs
are all plain `docker` CLI calls against a container name. The Docker daemon
itself is not a container and cannot be started/stopped/restarted through
this script -- doing so would kill every other container, including the
panel's own Postgres/Redis -- so it is status-only here.

Commands:
  status   -- Inspect all containers named in `payload["containers"]` plus
              Docker daemon reachability (`docker info`).
  start    -- `docker start <container>`.
  stop     -- `docker stop <container>`.
  restart  -- `docker restart <container>`.
  logs     -- `docker logs --tail N <container>` (stdout+stderr combined).

The container name for start/stop/restart/logs must be present in
`payload["containers"]` (the API's own whitelist, built from env config) --
this script never accepts an arbitrary container name from payload["container"]
without that cross-check, so a compromised/buggy caller can't be used to
control containers Vexlyx doesn't manage.

Never run this script as root; it never needs to be -- it only ever talks to
the Docker daemon over the bind-mounted socket.
"""

import json
import subprocess
import shutil
import sys

# ---------------------------------------------------------------------------
# Stream encoding (mirrors docker_manager.py / firewall_manager.py)
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


def fail(message: str, code: str = "SERVICE_STATUS_ERROR") -> None:
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)


def require_field(payload: dict, field: str) -> str:
    value = payload.get(field)
    if not value or not isinstance(value, str):
        fail(f"Missing required field: {field}", "INVALID_PAYLOAD")
    return value  # type: ignore[return-value]


def get_docker_binary() -> str:
    binary = shutil.which("docker")
    if binary:
        return binary
    fail(
        "Docker CLI not found in PATH. Make sure Docker Engine is running.",
        "DOCKER_NOT_FOUND",
    )
    return "docker"  # unreachable


def require_known_container(payload: dict) -> str:
    """
    Resolve the target container name and check it against the caller-supplied
    whitelist (payload["containers"], the API's own env-configured container
    names) so this script only ever start/stop/restart/reads logs for a
    container Vexlyx actually manages.
    """
    container = require_field(payload, "container")
    known = payload.get("containers")
    if not isinstance(known, list) or container not in known:
        fail(f"Unknown or unmanaged container: {container}", "UNKNOWN_CONTAINER")
    return container


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_status(payload: dict) -> None:
    docker_bin = get_docker_binary()
    containers = payload.get("containers")
    if not isinstance(containers, list) or not containers:
        fail("Missing required field: containers", "INVALID_PAYLOAD")

    services = []
    for name in containers:
        result = subprocess.run(
            [
                docker_bin,
                "inspect",
                "--format",
                "{{.State.Status}}|{{.State.StartedAt}}",
                name,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

        if result.returncode != 0:
            services.append({"container": name, "status": "unknown", "startedAt": None})
            continue

        parts = result.stdout.strip().split("|", 1)
        docker_status = parts[0] if parts else "unknown"
        started_at = parts[1] if len(parts) > 1 else None

        if docker_status == "running":
            status = "running"
        elif docker_status in ("exited", "created", "dead", "paused"):
            status = "stopped"
        else:
            status = "unknown"

        services.append({
            "container": name,
            "status": status,
            "startedAt": started_at if status == "running" else None,
        })

    daemon_check = subprocess.run(
        [docker_bin, "info"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    respond({
        "done": True,
        "services": services,
        "dockerDaemon": {"running": daemon_check.returncode == 0},
    })


def cmd_start(payload: dict) -> None:
    container = require_known_container(payload)
    docker_bin = get_docker_binary()
    result = subprocess.run(
        [docker_bin, "start", container],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if result.returncode != 0:
        fail(f"Failed to start {container}: {result.stderr.strip()}", "START_FAILED")
        return
    respond({"done": True})


def cmd_stop(payload: dict) -> None:
    container = require_known_container(payload)
    docker_bin = get_docker_binary()
    result = subprocess.run(
        [docker_bin, "stop", container],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if result.returncode != 0:
        fail(f"Failed to stop {container}: {result.stderr.strip()}", "STOP_FAILED")
        return
    respond({"done": True})


def cmd_restart(payload: dict) -> None:
    container = require_known_container(payload)
    docker_bin = get_docker_binary()
    result = subprocess.run(
        [docker_bin, "restart", container],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if result.returncode != 0:
        fail(f"Failed to restart {container}: {result.stderr.strip()}", "RESTART_FAILED")
        return
    respond({"done": True})


def cmd_logs(payload: dict) -> None:
    container = require_known_container(payload)
    tail = int(payload.get("tail", 200))
    docker_bin = get_docker_binary()

    result = subprocess.run(
        [docker_bin, "logs", f"--tail={tail}", container],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    if result.returncode != 0 and not result.stdout.strip() and not result.stderr.strip():
        fail(f"Failed to fetch logs for {container}: {result.stderr.strip()}", "LOGS_FAILED")
        return

    logs = (result.stdout + result.stderr).strip() or "No log output."
    respond({"done": True, "logs": logs})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

COMMANDS = {
    "status": cmd_status,
    "start": cmd_start,
    "stop": cmd_stop,
    "restart": cmd_restart,
    "logs": cmd_logs,
}


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        fail("No input received on stdin", "NO_INPUT")
        return

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Invalid JSON payload: {exc}", "INVALID_JSON")
        return

    command = payload.get("command", "")
    handler = COMMANDS.get(command)
    if not handler:
        fail(f"Unknown command: {command!r}", "UNKNOWN_COMMAND")
        return

    try:
        handler(payload)
    except subprocess.TimeoutExpired as exc:
        fail(f"Command timed out after {exc.timeout}s", "COMMAND_TIMEOUT")


if __name__ == "__main__":
    main()
