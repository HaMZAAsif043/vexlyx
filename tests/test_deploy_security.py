"""
test_deploy_security.py — Regression tests for deploy-time input and file
safety.

1. A custom deploy `domain` must be a plain hostname; Traefik rules are built
   by string substitution, so rule syntax in the value could match every host.
2. Dockerfile/.dockerignore and deploy/ files must not be read or written
   through symlinks planted in a cloned repository.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_MANAGER = REPO_ROOT / "system" / "python" / "build_manager.py"
DOCKER_MANAGER = REPO_ROOT / "system" / "python" / "docker_manager.py"
TEMPLATES_DIR = REPO_ROOT / "system" / "templates" / "docker-compose"

sys.path.insert(0, str(REPO_ROOT / "system" / "python"))


def run_py_script(script_path: Path, payload: dict) -> tuple[int, dict, str]:
    proc = subprocess.Popen(
        [sys.executable, str(script_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    stdout, stderr = proc.communicate(json.dumps(payload))
    lines = [line.strip() for line in stdout.strip().split("\n") if line.strip()]
    try:
        parsed = json.loads(lines[-1]) if lines else {}
    except Exception:
        parsed = {"raw": stdout}
    return proc.returncode, parsed, stderr


can_symlink = hasattr(os, "symlink")


def make_symlink(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError) as exc:
        raise unittest.SkipTest(f"cannot create symlinks here: {exc}")


class RouteHostnameTest(unittest.TestCase):
    def test_accepts_plain_hostnames(self):
        import docker_manager

        self.assertEqual(
            docker_manager.validate_route_hostname("App.Example.com"),
            "app.example.com",
        )
        self.assertEqual(
            docker_manager.validate_route_hostname("*.example.com"),
            "*.example.com",
        )

    def test_rejects_traefik_rule_syntax(self):
        import docker_manager

        for value in [
            "x`) || PathPrefix(`/",
            "x`) || HostRegexp(`{any:.*}`)",
            "app.example.com\nHost(`x`)",
            "app.example.com:8080",
            "http://app.example.com",
            "app..example.com",
            "app_example.com",
            "",
        ]:
            with self.subTest(value=value):
                with self.assertRaises(SystemExit):
                    docker_manager.validate_route_hostname(value)


@unittest.skipUnless(can_symlink, "symlinks or O_NOFOLLOW unavailable")
class DockerfileSymlinkTest(unittest.TestCase):
    def test_get_does_not_read_through_symlink(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            secret = project / "secret.txt"
            secret.write_text("PRIVATE KEY MATERIAL", encoding="utf-8")
            make_symlink(project / "Dockerfile", secret)
            make_symlink(project / ".dockerignore", secret)

            code, result, stderr = run_py_script(
                BUILD_MANAGER,
                {"command": "dockerfile-get", "projectDir": str(project)},
            )

            self.assertEqual(code, 0, stderr)
            self.assertFalse(result.get("hasDockerfile"), result)
            self.assertFalse(result.get("hasDockerignore"), result)
            self.assertNotIn("PRIVATE KEY MATERIAL", json.dumps(result))

    def test_save_refuses_to_write_through_symlink(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            project = Path(tmpdir)
            victim = project / "victim.txt"
            victim.write_text("original", encoding="utf-8")
            make_symlink(project / "Dockerfile", victim)

            code, result, stderr = run_py_script(
                BUILD_MANAGER,
                {
                    "command": "dockerfile-save",
                    "projectDir": str(project),
                    "dockerfile": "FROM alpine\n",
                },
            )

            self.assertNotEqual(code, 0, result)
            self.assertEqual(result.get("code"), "UNSAFE_DOCKERFILE_PATH", (result, stderr))
            self.assertEqual(victim.read_text(encoding="utf-8"), "original")
            self.assertTrue((project / "Dockerfile").is_symlink())


@unittest.skipUnless(can_symlink, "symlinks or O_NOFOLLOW unavailable")
class DeployFileSymlinkTest(unittest.TestCase):
    def test_compose_generation_refuses_symlinked_file(self):
        import docker_manager

        with tempfile.TemporaryDirectory() as tmpdir:
            deploy_dir = Path(tmpdir) / "deploy"
            deploy_dir.mkdir()
            victim = Path(tmpdir) / "victim.txt"
            victim.write_text("original", encoding="utf-8")
            make_symlink(deploy_dir / "docker-compose.yml", victim)

            with self.assertRaises(SystemExit):
                docker_manager.generate_compose_file(
                    compose_dir=deploy_dir,
                    template_path=TEMPLATES_DIR / "static.yml",
                    image_name="image",
                    service_name="svc",
                    hostname="app.example.com",
                    host_port=8100,
                    container_port=80,
                    memory_limit="512m",
                    env_vars={},
                )

            self.assertEqual(victim.read_text(encoding="utf-8"), "original")


if __name__ == "__main__":
    unittest.main()
