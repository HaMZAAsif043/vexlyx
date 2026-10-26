"""Tests for redis_manager.py (F5.30) — validation, config generation and
INFO parsing run without Docker; the create/health/delete path runs only
when a Docker engine is available and is skipped otherwise.

Run: python3 -m unittest discover -s tests -p test_redis_manager.py
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REDIS_MANAGER = REPO_ROOT / "system" / "python" / "redis_manager.py"


def load_manager():
    spec = importlib.util.spec_from_file_location("redis_manager", REDIS_MANAGER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


manager = load_manager()


def run_py_script(payload: dict) -> tuple[int, dict, str]:
    proc = subprocess.Popen(
        [sys.executable, str(REDIS_MANAGER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    stdout, stderr = proc.communicate(json.dumps(payload))
    lines = [line.strip() for line in stdout.strip().split("\n") if line.strip()]
    last_line = lines[-1] if lines else "{}"
    try:
        parsed = json.loads(last_line)
    except Exception:
        parsed = {"raw": stdout}
    return proc.returncode, parsed, stderr


def docker_available() -> bool:
    docker_bin = shutil.which("docker")
    if not docker_bin:
        return False
    try:
        res = subprocess.run(
            [docker_bin, "version"], capture_output=True, text=True, timeout=15
        )
        return res.returncode == 0
    except Exception:
        return False


DOCKER = docker_available()


class TestRedisManagerValidation(unittest.TestCase):
    """Every validation path runs through the real stdin/stdout contract."""

    VALID = {
        "containerName": "vexlyx-redis-shop-0123456789ab",
        "image": "valkey/valkey:8.0",
        "password": "a" * 32,
        "memoryLimitMb": 64,
        "evictionPolicy": "noeviction",
        "persistence": "RDB",
    }

    def run_with(self, **overrides) -> tuple[int, dict]:
        payload = {"command": "create_instance", **self.VALID, **overrides}
        code, result, _ = run_py_script(payload)
        return code, result

    def test_rejects_bad_container_names(self):
        for bad in [
            "vexlyx redis",           # space
            "container;drop",         # shell metachar
            "-leading-dash",          # must start alphanumeric
            "a" * 70,                 # too long
            "",                       # empty
        ]:
            code, result = self.run_with(containerName=bad)
            self.assertNotEqual(code, 0, f"expected rejection for {bad!r}")
            self.assertIn(result.get("code"), ("INVALID_IDENTIFIER", "INVALID_PAYLOAD"))

    def test_rejects_bad_passwords(self):
        for bad in ["short", "p@ssw0rd-with-symbols!", "x" * 200]:
            code, result = self.run_with(password=bad)
            self.assertNotEqual(code, 0, f"expected rejection for password {bad!r}")
            self.assertEqual(result.get("code"), "INVALID_PASSWORD")

    def test_rejects_unpinned_images(self):
        # The licence decision: never float on latest, never accept arbitrary refs.
        for bad in ["latest", "redis:latest", "redis:7-alpine", "evil/image:1", "valkey/valkey:8"]:
            code, result = self.run_with(image=bad)
            self.assertNotEqual(code, 0, f"expected rejection for image {bad!r}")
            self.assertEqual(result.get("code"), "INVALID_IMAGE")

    def test_rejects_bad_eviction_and_persistence_and_memory(self):
        code, result = self.run_with(evictionPolicy="allkeys-evil")
        self.assertEqual(result.get("code"), "INVALID_EVICTION_POLICY")

        code, result = self.run_with(persistence="SNAPSHOT")
        self.assertEqual(result.get("code"), "INVALID_PERSISTENCE")

        code, result = self.run_with(memoryLimitMb=4)
        self.assertEqual(result.get("code"), "INVALID_MEMORY_LIMIT")

        code, result = self.run_with(memoryLimitMb="not-a-number")
        self.assertEqual(result.get("code"), "INVALID_PAYLOAD")

    def test_rejects_unknown_commands(self):
        code, result, _ = run_py_script({"command": "format_disk"})
        self.assertNotEqual(code, 0)
        self.assertEqual(result.get("code"), "UNKNOWN_COMMAND")


class TestRedisConfigGeneration(unittest.TestCase):
    """Pure-function coverage: the generated redis.conf is the entire security
    and limits story, so it is asserted line by line."""

    def config(self, persistence: str) -> str:
        return manager.build_redis_config("secretPassword123", 128, "allkeys-lru", persistence)

    def test_common_directives(self):
        config = self.config("RDB")
        self.assertIn("requirepass secretPassword123", config)
        self.assertIn("maxmemory 128mb", config)
        self.assertIn("maxmemory-policy allkeys-lru", config)
        self.assertIn("protected-mode yes", config)
        self.assertIn("dir /data", config)

    def test_persistence_modes(self):
        rdb = self.config("RDB")
        self.assertIn("save 900 1", rdb)
        self.assertIn("appendonly no", rdb)

        aof = self.config("AOF")
        self.assertIn("appendonly yes", aof)
        self.assertIn('save ""', aof)

        none = self.config("NONE")
        self.assertIn('save ""', none)
        self.assertIn("appendonly no", none)

    def test_dangerous_commands_renamed_away(self):
        config = self.config("RDB")
        for command in ("CONFIG", "FLUSHALL", "FLUSHDB", "DEBUG", "SHUTDOWN"):
            self.assertIn(f'rename-command {command} ""', config)


class TestInfoParsing(unittest.TestCase):
    def test_parse_info_and_totals(self):
        sample = """# Server
redis_version:7.2.4
uptime_in_seconds:3600
# Clients
connected_clients:3
# Memory
used_memory:1048576
maxmemory:134217728
# Stats
evicted_keys:7
# Keyspace
db0:keys=42,expires=0,avg_ttl=0
"""
        info = manager.parse_info(sample)
        self.assertEqual(info["connected_clients"], "3")
        self.assertEqual(info["used_memory"], "1048576")
        self.assertEqual(info["evicted_keys"], "7")
        self.assertIn("db0", info)

    def test_health_snippet_reads_password_from_config_only(self):
        # The exec snippet must never interpolate the password itself, and it
        # must never put it into the CLI's argv (`-a "$PW"` was visible in the
        # host's `ps`); REDISCLI_AUTH is exported only for the exec'd process.
        self.assertNotIn("secret", manager._CLI_SNIPPET)
        self.assertIn("sed -n", manager._CLI_SNIPPET)
        self.assertIn("requirepass", manager._CLI_SNIPPET)
        self.assertNotIn("-a ", manager._CLI_SNIPPET)
        self.assertIn('REDISCLI_AUTH="$PW"', manager._CLI_SNIPPET)
        self.assertIn(manager.CONFIG_RELPATH, manager._CLI_SNIPPET)


def cp(rc=0, stdout="", stderr=""):
    """CompletedProcess factory for the run_bounded stub (returns a fresh
    instance per call so callers can share one rule)."""
    return lambda cmd: subprocess.CompletedProcess(cmd, rc, stdout, stderr)


class DockerStub:
    """Stands in for manager.run_bounded: records every docker invocation and
    answers from an ordered (matcher, responder) script; unmatched commands
    succeed with no output."""

    def __init__(self, rules=()):
        self.rules = list(rules)
        self.calls = []

    def __call__(self, timeout, cmd, *, fatal=True, **kwargs):
        self.calls.append(list(cmd))
        for matcher, respond in self.rules:
            if matcher(cmd):
                return respond(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def argv(self):
        return [" ".join(cmd[1:]) for cmd in self.calls]


VALID_PAYLOAD = {
    "command": "create_instance",
    "containerName": "vexlyx-redis-unit-000000000001",
    "image": "valkey/valkey:8.0",
    "password": "a" * 32,
    "memoryLimitMb": 64,
    "evictionPolicy": "noeviction",
    "persistence": "RDB",
}


class ManagerCommandTestCase(unittest.TestCase):
    """Runs the module's command functions in-process with a stubbed docker
    layer and an isolated config dir."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._old_config_dir = os.environ.get("REDIS_INSTANCE_CONFIG_DIR")
        os.environ["REDIS_INSTANCE_CONFIG_DIR"] = self.tmp.name
        self.addCleanup(self._restore_config_dir)
        self.patch("get_docker_binary", lambda: "docker")

    def _restore_config_dir(self):
        if self._old_config_dir is None:
            os.environ.pop("REDIS_INSTANCE_CONFIG_DIR", None)
        else:
            os.environ["REDIS_INSTANCE_CONFIG_DIR"] = self._old_config_dir

    def patch(self, name, value):
        original = getattr(manager, name)
        setattr(manager, name, value)
        self.addCleanup(setattr, manager, name, original)

    def use_stub(self, *rules) -> DockerStub:
        stub = DockerStub(rules)
        self.patch("run_bounded", stub)
        return stub

    def config_dir_for(self, container_name) -> Path:
        return Path(self.tmp.name) / container_name

    def run_cmd(self, payload: dict) -> tuple[int, dict]:
        """Invoke a command in-process; returns (exit_code, last JSON on stdout)."""
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            try:
                manager.COMMANDS[payload["command"]](payload)
            except SystemExit as exc:
                return int(exc.code or 1), self._last_json(buffer.getvalue())
        return 0, self._last_json(buffer.getvalue())

    @staticmethod
    def _last_json(stdout: str) -> dict:
        lines = [line for line in stdout.splitlines() if line.strip()]
        try:
            return json.loads(lines[-1])
        except (IndexError, json.JSONDecodeError):
            return {"raw": stdout}


class TestDockerRunArguments(ManagerCommandTestCase):
    def test_config_mount_is_absolute_and_matches_server_argument(self):
        # Docker rejects relative -v targets, so every create/recreate used
        # to fail at `docker run` — and recreation had already removed the old
        # container by that point.
        stub = self.use_stub()
        container = VALID_PAYLOAD["containerName"]
        manager.write_config(container, VALID_PAYLOAD["password"], 64, "noeviction", "RDB")
        manager.run_container("docker", container, "valkey/valkey:8.0", 64)

        run_cmd = next(cmd for cmd in stub.calls if cmd[1] == "run")
        mounts = [run_cmd[i + 1] for i, arg in enumerate(run_cmd) if arg == "-v"]
        config_mount = next(m for m in mounts if m.endswith("redis.conf:ro"))
        container_path = config_mount.split(":")[-2]
        self.assertTrue(container_path.startswith("/"), "docker requires an absolute in-container path")
        self.assertEqual(container_path, manager.CONFIG_RELPATH)
        self.assertEqual(run_cmd[-1], manager.CONFIG_RELPATH)


class TestRemoveContainerConfidence(ManagerCommandTestCase):
    """A Docker outage must never look like a successful removal."""

    CONTAINER = VALID_PAYLOAD["containerName"]

    def test_reports_removed_when_rm_reports_no_such_container(self):
        stub = self.use_stub(
            (lambda c: c[1:3] == ["rm", "-f"], cp(rc=1, stderr="Error: No such container: x")),
        )
        self.assertTrue(manager.remove_container("docker", self.CONTAINER))
        self.assertEqual(len(stub.calls), 1)

    def test_confirms_absence_via_inspect_when_rm_gives_another_error(self):
        self.use_stub(
            (lambda c: c[1] == "rm", cp(rc=1, stderr="rm exploded")),
            (lambda c: c[1] == "inspect", cp(rc=1, stderr="Error: No such object: x")),
        )
        self.assertTrue(manager.remove_container("docker", self.CONTAINER))

    def test_docker_outage_is_not_a_successful_removal(self):
        outage = cp(rc=1, stderr="Cannot connect to the Docker daemon at unix:///var/run/docker.sock.")
        self.use_stub(
            (lambda c: c[1] in ("rm", "inspect"), lambda cmd: outage(cmd)),
        )
        self.assertFalse(manager.remove_container("docker", self.CONTAINER))

    def test_container_that_still_exists_is_not_removed(self):
        self.use_stub(
            (lambda c: c[1] == "rm", cp(rc=1, stderr="rm exploded")),
            (lambda c: c[1] == "inspect", cp(rc=0, stdout="running")),
        )
        self.assertFalse(manager.remove_container("docker", self.CONTAINER))


class TestRecreateStopsGracefully(ManagerCommandTestCase):
    CONTAINER = VALID_PAYLOAD["containerName"]

    def setUp(self):
        super().setUp()
        self.patch("wait_healthy", lambda *args: None)

    def payload(self):
        return {**VALID_PAYLOAD, "command": "recreate_instance"}

    def test_stop_precedes_force_remove_and_run(self):
        stub = self.use_stub(
            (lambda c: c[1] == "inspect", cp(rc=0, stdout="running")),
        )
        code, result = self.run_cmd(self.payload())
        self.assertEqual(code, 0, result)
        argv = stub.argv()
        stop_at = next(i for i, a in enumerate(argv) if a.startswith("stop -t 15"))
        rm_at = next(i for i, a in enumerate(argv) if a.startswith("rm -f"))
        run_at = next(i for i, a in enumerate(argv) if a == "run -d" or a.startswith("run -d"))
        self.assertLess(stop_at, rm_at, "redis must be stopped (flushing its snapshot) before the container is replaced")
        self.assertLess(rm_at, run_at)

    def test_refuses_to_force_remove_when_the_graceful_stop_fails(self):
        stub = self.use_stub(
            (lambda c: c[1] == "inspect", cp(rc=0, stdout="running")),
            (lambda c: c[1] == "stop", cp(rc=1, stderr="cannot stop")),
        )
        code, result = self.run_cmd(self.payload())
        self.assertEqual(code, 1)
        self.assertEqual(result.get("code"), "RECREATE_FAILED")
        self.assertFalse(
            any(a.startswith("rm -f") for a in stub.argv()),
            "force-removing after a failed stop would SIGKILL redis and lose unsaved writes",
        )


class TestDeleteOrdering(ManagerCommandTestCase):
    """The teardown must go container -> volume -> config, failing loudly at
    the first step that cannot be confirmed (the API keeps the row)."""

    CONTAINER = VALID_PAYLOAD["containerName"]

    def setUp(self):
        super().setUp()
        manager.write_config(self.CONTAINER, "a" * 32, 64, "noeviction", "RDB")
        self.assertTrue(self.config_dir_for(self.CONTAINER).exists())

    def payload(self):
        return {"command": "delete_instance", "containerName": self.CONTAINER}

    def test_container_removal_failure_keeps_config_and_skips_volume(self):
        stub = self.use_stub(
            (lambda c: c[1] == "rm", cp(rc=1, stderr="rm exploded")),
            (lambda c: c[1] == "inspect", cp(rc=0, stdout="running")),
        )
        code, result = self.run_cmd(self.payload())
        self.assertEqual(code, 1)
        self.assertEqual(result.get("code"), "TEARDOWN_FAILED")
        self.assertTrue(self.config_dir_for(self.CONTAINER).exists(), "config must survive so the instance can still start")
        self.assertFalse(any(c[1] == "volume" for c in stub.calls))

    def test_docker_outage_is_not_a_successful_teardown(self):
        outage = cp(rc=1, stderr="Cannot connect to the Docker daemon at unix:///var/run/docker.sock.")
        self.use_stub((lambda c: c[1] in ("rm", "inspect"), lambda cmd: outage(cmd)))
        code, result = self.run_cmd(self.payload())
        self.assertEqual(code, 1)
        self.assertEqual(result.get("code"), "TEARDOWN_FAILED")
        self.assertTrue(self.config_dir_for(self.CONTAINER).exists())

    def test_volume_removal_failure_keeps_config(self):
        self.use_stub(
            (lambda c: c[1] == "rm", cp()),
            (lambda c: c[1] == "volume", cp(rc=1, stderr="volume is in use")),
        )
        code, result = self.run_cmd(self.payload())
        self.assertEqual(code, 1)
        self.assertEqual(result.get("code"), "TEARDOWN_FAILED")
        self.assertTrue(self.config_dir_for(self.CONTAINER).exists())

    def test_config_is_removed_only_after_container_and_volume_are_gone(self):
        self.use_stub(
            (lambda c: c[1] == "rm", cp()),
            (lambda c: c[1] == "volume", cp(rc=1, stderr="Error response from daemon: No such volume: x")),
        )
        code, result = self.run_cmd(self.payload())
        self.assertEqual(code, 0, result)
        self.assertTrue(result.get("success"))
        self.assertTrue(result.get("volumeRemoved"))
        self.assertFalse(self.config_dir_for(self.CONTAINER).exists())


class TestCreateCleansUpAfterItself(ManagerCommandTestCase):
    def test_failed_provisioning_removes_container_volume_and_config(self):
        container = VALID_PAYLOAD["containerName"]
        stub = self.use_stub(
            (lambda c: c[1] == "inspect", cp(rc=1, stderr="Error: No such container: x")),
            (lambda c: c[1] == "run", cp(rc=1, stderr="docker run exploded")),
        )
        code, result = self.run_cmd(VALID_PAYLOAD)
        self.assertEqual(code, 1)
        self.assertEqual(result.get("code"), "CREATE_FAILED")
        argv = stub.argv()
        self.assertTrue(any(a.startswith("rm -f") for a in argv), argv)
        self.assertTrue(any(a.startswith("volume rm") for a in argv), argv)
        self.assertFalse(self.config_dir_for(container).exists(), "a failed create must not leave an untracked config behind")


@unittest.skipUnless(DOCKER, "Docker engine is required for the lifecycle test")
class TestRedisLifecycle(unittest.TestCase):
    CONTAINER = "vexlyx-redis unittest-lifecycle-0001"

    def test_create_ping_stats_delete(self):
        container = self.CONTAINER.replace(" ", "-")
        code, result, stderr = run_py_script({
            "command": "create_instance",
            "containerName": container,
            "image": "valkey/valkey:8.0",
            "password": "b" * 32,
            "memoryLimitMb": 64,
            "evictionPolicy": "noeviction",
            "persistence": "NONE",
        })
        self.assertEqual(code, 0, f"create failed: {result} {stderr}")
        self.assertTrue(result.get("success"))

        try:
            code, result, _ = run_py_script({"command": "stats_instance", "containerName": container})
            self.assertEqual(code, 0, f"stats failed: {result}")
            self.assertIn("usedMemoryBytes", result)
            self.assertGreaterEqual(result["uptimeSeconds"], 0)
        finally:
            code, result, _ = run_py_script({"command": "delete_instance", "containerName": container})
            self.assertEqual(code, 0, f"delete failed: {result}")
            self.assertTrue(result.get("containerRemoved"))

    def test_delete_is_idempotent(self):
        code, result, _ = run_py_script({
            "command": "delete_instance",
            "containerName": "vexlyx-redis-never-existed-0001",
        })
        self.assertEqual(code, 0)
        self.assertTrue(result.get("success"))


if __name__ == "__main__":
    unittest.main()
