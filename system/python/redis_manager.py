#!/usr/bin/env python3
"""
redis_manager.py -- System-layer script for Vexlyx Redis instances (F5.30).

Manages one dedicated Redis-compatible container per instance: create,
recreate (limits/password changes), start/stop/restart, stats and teardown.
Each instance gets its own container on the internal `traefik-net` network,
a named volume at /data, and a generated redis.conf (mounted read-only)
carrying requirepass, maxmemory, the eviction policy and persistence mode.

The password lives ONLY in that config file (chmod 600 on the host, mounted
:ro into the container) — never in a command-line argument, environment
variable or docker inspect field. This script NEVER touches the panel's own
Redis (vexlyx-redis): tenant isolation is one container per instance.

Called by the Fastify API via child_process.spawn with a JSON payload on
stdin. Writes JSON results to stdout and exits with code 0 on success,
1 on error. All docker invocations are argument lists (never shell strings)
and bounded by hard timeouts.

Commands:
  create_instance    -- Write config, run the container, wait until healthy.
  recreate_instance  -- Replace the container (same volume) with new settings.
  delete_instance    -- Remove container, volume and config directory.
  start_instance     -- docker start.
  stop_instance      -- docker stop.
  restart_instance   -- docker restart.
  stats_instance     -- used memory, key count, clients, uptime from INFO.
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

if sys.stdout.encoding is None or sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# JSON I/O + validation helpers (same contract as database_manager.py)
# ---------------------------------------------------------------------------


def respond(data: dict) -> None:
    print(json.dumps(data), flush=True)


def log_line(message: str) -> None:
    print(json.dumps({"log": message}), flush=True)


def fail(message: str, code: str = "REDIS_ERROR") -> None:
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
    """Validate container/volume names to keep them out of docker arg parsing."""
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$", name):
        fail(
            f"Invalid {field_name} '{name}'. Must be 1-63 alphanumeric, underscore, dot, or hyphen characters starting with alphanumeric.",
            "INVALID_IDENTIFIER",
        )
    return name


def validate_password(password: str) -> str:
    """The password is written verbatim into redis.conf; only allow a charset
    that can never alter the config file's structure."""
    if not re.match(r"^[A-Za-z0-9]{16,128}$", password):
        fail(
            "Invalid password. Must be 16-128 alphanumeric characters.",
            "INVALID_PASSWORD",
        )
    return password


def validate_image(image: str) -> str:
    """Pinned image lines only — never `latest` (licence decision documented
    in docs/dev/redis-instances.md: Valkey is BSD, Redis line stops at 7.2)."""
    if image not in ALLOWED_IMAGES:
        fail(
            f"Unsupported image '{image}'. Allowed: {', '.join(sorted(ALLOWED_IMAGES))}",
            "INVALID_IMAGE",
        )
    return image


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Pinned, licence-clean image lines. Keep in sync with RedisImageEnum in
# packages/shared/src/schemas/redisInstances.ts.
ALLOWED_IMAGES = {"valkey/valkey:8.0", "redis:7.2-alpine"}

ALLOWED_EVICTION = {
    "noeviction",
    "allkeys-lru",
    "volatile-lru",
    "allkeys-lfu",
    "volatile-lfu",
    "allkeys-random",
    "volatile-random",
    "volatile-ttl",
}

ALLOWED_PERSISTENCE = {"NONE", "RDB", "AOF"}

# Every project container and every infra service joins this network; tenant
# Redis instances publish NO host port and are reachable only from it.
NETWORK_NAME = "traefik-net"

CONFIG_RELPATH = "usr/local/etc/redis/redis.conf"

# Docker's limit sits above maxmemory: a background RDB fork or AOF rewrite
# briefly doubles the process's memory, and OOM-killing the container for
# doing exactly what it was told to do would look like a crash.
DOCKER_MEMORY_HEADROOM_MB = 32

QUICK_TIMEOUT = 30        # inspect / stop / start / restart
STATS_TIMEOUT = 60        # docker exec ... info
CREATE_TIMEOUT = 240      # docker run (image pull can be slow on first create)
HEALTH_WAIT_TIMEOUT = 90  # wait for the healthcheck to report healthy

# Shell snippet executed INSIDE the container: reads requirepass from the
# mounted config so the password never appears in a docker exec argument
# (visible in host `ps`) or environment variable (visible in docker inspect).
_CLI_SNIPPET = (
    'PW=$(sed -n "s/^requirepass //p" /usr/local/etc/redis/redis.conf); '
    'CLI=$(command -v valkey-cli || command -v redis-cli) || exit 127; '
    'exec "$CLI" --no-auth-warning -a "$PW" {}'
)


# ---------------------------------------------------------------------------
# Bounded subprocess execution (same shape as docker_manager.py)
# ---------------------------------------------------------------------------


def _group_popen_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def kill_process_tree(proc: subprocess.Popen) -> None:
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
        try:
            proc.kill()
        except Exception:
            pass


def run_bounded(
    timeout: int,
    cmd: list[str],
    *,
    fatal: bool = True,
    **kwargs,
) -> subprocess.CompletedProcess:
    """Run a command bounded by `timeout` seconds; kill the whole group on
    expiry. With fatal=False returns rc 124 instead of exiting."""
    group = _group_popen_kwargs()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **group,
        **kwargs,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    except subprocess.TimeoutExpired:
        kill_process_tree(proc)
        try:
            proc.communicate(timeout=10)
        except Exception:
            pass
        if fatal:
            fail(f"`{' '.join(cmd[:3])}...` timed out after {timeout}s", "COMMAND_TIMEOUT")
        return subprocess.CompletedProcess(cmd, 124, "", f"timed out after {timeout}s")


# ---------------------------------------------------------------------------
# Config + docker helpers
# ---------------------------------------------------------------------------


def get_config_dir() -> Path:
    """Host directory holding per-instance config files. Holds requirepass,
    so files are chmod 600 and the directory should not be world-readable."""
    override = os.environ.get("REDIS_INSTANCE_CONFIG_DIR")
    if override:
        return Path(override)
    # system/python/redis_manager.py -> repo root
    return Path(__file__).resolve().parents[2] / "workspaces" / "redis-instances"


def build_redis_config(
    password: str,
    memory_limit_mb: int,
    eviction_policy: str,
    persistence: str,
) -> str:
    lines = [
        "# Generated by redis_manager.py -- do not edit; recreated on every update.",
        "protected-mode yes",
        "port 6379",
        "daemonize no",
        "dir /data",
        f"requirepass {password}",
        f"maxmemory {memory_limit_mb}mb",
        f"maxmemory-policy {eviction_policy}",
    ]
    if persistence == "RDB":
        lines += ["save 900 1", "save 300 10", "save 60 10000", "appendonly no"]
    elif persistence == "AOF":
        lines += ["appendonly yes", "appendfsync everysec", 'save ""']
    else:  # NONE
        lines += ['save ""', "appendonly no"]
    # Rename dangerous administrative commands away: any app holding the
    # connection URL has no business reconfiguring or wiping its instance,
    # and CONFIG in particular can turn a Redis into arbitrary file write.
    for command in ("CONFIG", "FLUSHALL", "FLUSHDB", "DEBUG", "SHUTDOWN"):
        lines.append(f'rename-command {command} ""')
    return "\n".join(lines) + "\n"


def write_config(
    container_name: str,
    password: str,
    memory_limit_mb: int,
    eviction_policy: str,
    persistence: str,
) -> Path:
    config_dir = get_config_dir() / container_name
    config_dir.mkdir(parents=True, exist_ok=True)
    path = config_dir / "redis.conf"
    path.write_text(
        build_redis_config(password, memory_limit_mb, eviction_policy, persistence),
        encoding="utf-8",
    )
    os.chmod(path, 0o600)
    return path


def remove_config(container_name: str) -> None:
    shutil.rmtree(get_config_dir() / container_name, ignore_errors=True)


def ensure_network(docker_bin: str) -> None:
    res = run_bounded(QUICK_TIMEOUT, [docker_bin, "network", "inspect", NETWORK_NAME], fatal=False)
    if res.returncode != 0:
        log_line(f"[vexlyx] Creating Docker network: {NETWORK_NAME}")
        created = run_bounded(QUICK_TIMEOUT, [docker_bin, "network", "create", NETWORK_NAME], fatal=False)
        if created.returncode != 0:
            fail(f"Failed to create Docker network '{NETWORK_NAME}': {created.stderr.strip()}", "NETWORK_CREATE_FAILED")


def container_exists(docker_bin: str, container_name: str) -> bool:
    res = run_bounded(QUICK_TIMEOUT, [docker_bin, "inspect", "--format", "{{.State.Status}}", container_name], fatal=False)
    return res.returncode == 0


def container_logs(docker_bin: str, container_name: str, tail: int = 20) -> str:
    res = run_bounded(QUICK_TIMEOUT, [docker_bin, "logs", "--tail", str(tail), container_name], fatal=False)
    return (res.stdout or res.stderr or "").strip()


def remove_container(docker_bin: str, container_name: str) -> bool:
    """Force-remove the container. Returns True when it is gone afterwards
    (including when it never existed)."""
    res = run_bounded(QUICK_TIMEOUT, [docker_bin, "rm", "-f", container_name], fatal=False)
    if res.returncode == 0:
        return True
    # Idempotent teardown: a container that is already gone is success.
    return not container_exists(docker_bin, container_name)


def wait_healthy(docker_bin: str, container_name: str, timeout: int) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        res = run_bounded(
            QUICK_TIMEOUT,
            [docker_bin, "inspect", "--format", "{{.State.Health.Status}}", container_name],
            fatal=False,
        )
        if res.returncode != 0:
            fail(
                f"Container '{container_name}' disappeared while waiting for health: {container_logs(docker_bin, container_name)}",
                "CREATE_FAILED",
            )
        status = res.stdout.strip()
        if status == "healthy":
            return
        time.sleep(2)
    fail(
        f"Instance '{container_name}' did not become healthy within {timeout}s. Logs: {container_logs(docker_bin, container_name)}",
        "CREATE_FAILED",
    )


def run_container(
    docker_bin: str,
    container_name: str,
    image: str,
    memory_limit_mb: int,
) -> None:
    docker_memory_mb = memory_limit_mb + DOCKER_MEMORY_HEADROOM_MB
    health_cmd = "sh -c '" + _CLI_SNIPPET.format("ping") + "'"
    cmd = [
        docker_bin,
        "run",
        "-d",
        "--name", container_name,
        "--network", NETWORK_NAME,
        "--restart", "unless-stopped",
        "--memory", f"{docker_memory_mb}m",
        "--memory-swap", f"{docker_memory_mb}m",
        "-v", f"{container_name}-data:/data",
        "-v", f"{get_config_dir() / container_name / 'redis.conf'}:{CONFIG_RELPATH}:ro",
        "--health-cmd", health_cmd,
        "--health-interval", "10s",
        "--health-timeout", "5s",
        "--health-retries", "6",
        "--health-start-period", "10s",
        "--label", "vexlyx.managed=true",
        "--label", "vexlyx.redis_instance=true",
        image,
        # Valkey ships valkey-server, Redis ships redis-server.
        ("valkey-server" if image.startswith("valkey/") else "redis-server"),
        f"/{CONFIG_RELPATH}",
    ]
    res = run_bounded(CREATE_TIMEOUT, cmd, fatal=False)
    if res.returncode != 0:
        fail(
            f"Failed to start Redis container '{container_name}': {res.stderr.strip() or res.stdout.strip()}",
            "CREATE_FAILED",
        )


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _validated_settings(payload: dict) -> dict:
    container_name = validate_identifier(require_field(payload, "containerName"), "containerName")
    password = validate_password(require_field(payload, "password"))
    image = validate_image(require_field(payload, "image"))

    try:
        memory_limit_mb = int(payload.get("memoryLimitMb", 64))
    except (TypeError, ValueError):
        fail("memoryLimitMb must be an integer", "INVALID_PAYLOAD")
        return {}
    if not 16 <= memory_limit_mb <= 65536:
        fail("memoryLimitMb must be between 16 and 65536", "INVALID_MEMORY_LIMIT")
        return {}

    eviction_policy = str(payload.get("evictionPolicy", "noeviction"))
    if eviction_policy not in ALLOWED_EVICTION:
        fail(f"Invalid evictionPolicy '{eviction_policy}'. Allowed: {', '.join(sorted(ALLOWED_EVICTION))}", "INVALID_EVICTION_POLICY")
        return {}

    persistence = str(payload.get("persistence", "RDB")).upper()
    if persistence not in ALLOWED_PERSISTENCE:
        fail(f"Invalid persistence '{persistence}'. Allowed: {', '.join(sorted(ALLOWED_PERSISTENCE))}", "INVALID_PERSISTENCE")
        return {}

    return {
        "containerName": container_name,
        "password": password,
        "image": image,
        "memoryLimitMb": memory_limit_mb,
        "evictionPolicy": eviction_policy,
        "persistence": persistence,
    }


def cmd_create_instance(payload: dict) -> None:
    settings = _validated_settings(payload)
    docker_bin = get_docker_binary()
    container_name = settings["containerName"]

    if container_exists(docker_bin, container_name):
        fail(
            f"Container '{container_name}' already exists. Refusing to overwrite it (the panel's own Redis and stray containers must never be reused).",
            "CONTAINER_EXISTS",
        )

    ensure_network(docker_bin)
    write_config(
        container_name,
        settings["password"],
        settings["memoryLimitMb"],
        settings["evictionPolicy"],
        settings["persistence"],
    )
    log_line(f"[vexlyx] Starting Redis instance container '{container_name}' ({settings['image']}, {settings['memoryLimitMb']}MB)")
    run_container(docker_bin, container_name, settings["image"], settings["memoryLimitMb"])
    wait_healthy(docker_bin, container_name, HEALTH_WAIT_TIMEOUT)

    respond({
        "success": True,
        "container": container_name,
        "volume": f"{container_name}-data",
        "image": settings["image"],
        "status": "RUNNING",
    })


def cmd_recreate_instance(payload: dict) -> None:
    """Replace the container with identical volume but new settings — the
    path used for limit changes and password rotation (a running redis-server
    cannot safely rewrite requirepass/maxmemory behind our back)."""
    settings = _validated_settings(payload)
    docker_bin = get_docker_binary()
    container_name = settings["containerName"]

    ensure_network(docker_bin)
    if not remove_container(docker_bin, container_name):
        fail(f"Failed to remove existing container '{container_name}' for recreation", "RECREATE_FAILED")

    write_config(
        container_name,
        settings["password"],
        settings["memoryLimitMb"],
        settings["evictionPolicy"],
        settings["persistence"],
    )
    log_line(f"[vexlyx] Recreating Redis instance container '{container_name}'")
    run_container(docker_bin, container_name, settings["image"], settings["memoryLimitMb"])
    wait_healthy(docker_bin, container_name, HEALTH_WAIT_TIMEOUT)

    respond({
        "success": True,
        "container": container_name,
        "volume": f"{container_name}-data",
        "image": settings["image"],
        "status": "RUNNING",
    })


def cmd_delete_instance(payload: dict) -> None:
    container_name = validate_identifier(require_field(payload, "containerName"), "containerName")
    docker_bin = get_docker_binary()

    removed_container = remove_container(docker_bin, container_name)

    volume_res = run_bounded(QUICK_TIMEOUT, [docker_bin, "volume", "rm", f"{container_name}-data"], fatal=False)
    volume_removed = volume_res.returncode == 0 or "No such volume" in (volume_res.stderr or "")

    remove_config(container_name)

    if not removed_container:
        # The container is still there and could not be removed — report it
        # rather than pretending the teardown succeeded (the API keeps the
        # row so the instance stays visible and retryable).
        fail(
            f"Failed to remove container '{container_name}'. It may still be running; retry the delete.",
            "TEARDOWN_FAILED",
        )

    respond({
        "success": True,
        "container": container_name,
        "containerRemoved": removed_container,
        "volumeRemoved": volume_removed,
        "configRemoved": True,
    })


def _require_existing_container(payload: dict) -> tuple[str, str]:
    container_name = validate_identifier(require_field(payload, "containerName"), "containerName")
    docker_bin = get_docker_binary()
    if not container_exists(docker_bin, container_name):
        fail(f"Container '{container_name}' not found", "CONTAINER_NOT_FOUND")
    return docker_bin, container_name


def cmd_start_instance(payload: dict) -> None:
    docker_bin, container_name = _require_existing_container(payload)
    res = run_bounded(QUICK_TIMEOUT, [docker_bin, "start", container_name], fatal=False)
    if res.returncode != 0:
        fail(f"Failed to start '{container_name}': {res.stderr.strip()}", "START_FAILED")
    respond({"success": True, "container": container_name, "status": "RUNNING"})


def cmd_stop_instance(payload: dict) -> None:
    docker_bin, container_name = _require_existing_container(payload)
    res = run_bounded(QUICK_TIMEOUT, [docker_bin, "stop", "-t", "15", container_name], fatal=False)
    if res.returncode != 0:
        fail(f"Failed to stop '{container_name}': {res.stderr.strip()}", "STOP_FAILED")
    respond({"success": True, "container": container_name, "status": "STOPPED"})


def cmd_restart_instance(payload: dict) -> None:
    docker_bin, container_name = _require_existing_container(payload)
    res = run_bounded(QUICK_TIMEOUT, [docker_bin, "restart", "-t", "15", container_name], fatal=False)
    if res.returncode != 0:
        fail(f"Failed to restart '{container_name}': {res.stderr.strip()}", "RESTART_FAILED")
    respond({"success": True, "container": container_name, "status": "RUNNING"})


def parse_info(text: str) -> dict:
    info = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            key, _, value = line.partition(":")
            info[key] = value
    return info


def cmd_stats_instance(payload: dict) -> None:
    docker_bin, container_name = _require_existing_container(payload)

    res = run_bounded(
        STATS_TIMEOUT,
        [
            docker_bin, "exec", container_name,
            "sh", "-c", _CLI_SNIPPET.format("info"),
        ],
        fatal=False,
    )
    if res.returncode != 0:
        fail(
            f"Failed to read INFO from '{container_name}': {res.stderr.strip() or res.stdout.strip()}",
            "STATS_FAILED",
        )

    info = parse_info(res.stdout)

    def as_int(key: str, default: int = 0) -> int:
        try:
            return int(info.get(key, default))
        except (TypeError, ValueError):
            return default

    used_memory = as_int("used_memory")
    max_memory = as_int("maxmemory")
    total_keys = 0
    for key, value in info.items():
        if re.match(r"^db\d+$", key):
            match = re.search(r"keys=(\d+)", value)
            if match:
                total_keys += int(match.group(1))

    respond({
        "container": container_name,
        "usedMemoryBytes": used_memory,
        "usedMemoryPercent": round(used_memory / max_memory * 100, 1) if max_memory > 0 else None,
        "connectedClients": as_int("connected_clients"),
        "totalKeys": total_keys,
        "evictedKeys": as_int("evicted_keys"),
        "uptimeSeconds": as_int("uptime_in_seconds"),
    })


COMMANDS = {
    "create_instance": cmd_create_instance,
    "recreate_instance": cmd_recreate_instance,
    "delete_instance": cmd_delete_instance,
    "start_instance": cmd_start_instance,
    "stop_instance": cmd_stop_instance,
    "restart_instance": cmd_restart_instance,
    "stats_instance": cmd_stats_instance,
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
