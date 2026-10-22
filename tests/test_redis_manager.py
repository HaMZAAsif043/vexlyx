"""Tests for redis_manager.py (F5.30) — validation, config generation and
INFO parsing run without Docker; the create/health/delete path runs only
when a Docker engine is available and is skipped otherwise.

Run: python3 -m unittest discover -s tests -p test_redis_manager.py
"""

import importlib.util
import json
import subprocess
import sys
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
        # The exec snippet must never interpolate the password itself.
        self.assertNotIn("secret", manager._CLI_SNIPPET)
        self.assertIn("sed -n", manager._CLI_SNIPPET)
        self.assertIn("requirepass", manager._CLI_SNIPPET)


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
