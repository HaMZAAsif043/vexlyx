"""Traefik static config handling in the installer (#155).

Static config is only read at start-up and the rendered file is a single-file
bind mount, so `docker compose up -d` never notices it changing. The installer
must restart Traefik exactly once when the rendered file changed, and never
when it did not (a restart drops every site for a few seconds).
"""

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
LIB_SH = ROOT_DIR / "system" / "scripts" / "install" / "lib.sh"
PROD_TEMPLATE = ROOT_DIR / "docker" / "traefik" / "traefik.prod.yml.tmpl"
DEV_CONFIG = ROOT_DIR / "docker" / "traefik" / "traefik.yml"


def entrypoint_block(text: str, name: str) -> str:
    """Returns the indented lines belonging to one entryPoint."""
    lines = text.replace("\r\n", "\n").split("\n")
    start = lines.index(f"  {name}:")
    block = []
    for line in lines[start + 1:]:
        if line.startswith("    ") or not line.strip():
            block.append(line)
        else:
            break
    return "\n".join(block)


class TraefikTimeoutConfigTest(unittest.TestCase):
    def test_prod_template_disables_the_read_timeout_on_websecure(self) -> None:
        block = entrypoint_block(PROD_TEMPLATE.read_text(encoding="utf-8"), "websecure")
        self.assertIn("respondingTimeouts:", block)
        self.assertIn("readTimeout: 0s", block)
        self.assertRegex(block, r"idleTimeout: \d+s")

    def test_dev_config_disables_the_read_timeout_on_websecure(self) -> None:
        block = entrypoint_block(DEV_CONFIG.read_text(encoding="utf-8"), "websecure")
        self.assertIn("readTimeout: 0s", block)


class TraefikRestartOnConfigChangeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bash = shutil.which("bash")
        if not self.bash:
            self.skipTest("bash is required")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.template = self.tmp / "traefik.tmpl"
        self.template.write_text('email: "__ACME_EMAIL__"\nversion: 1\n', encoding="utf-8", newline="\n")
        self.dest = self.tmp / "traefik.prod.yml"
        self.docker_calls = self.tmp / "docker-calls"
        fake_bin = self.tmp / "bin"
        fake_bin.mkdir()
        fake_docker = fake_bin / "docker"
        fake_docker.write_text(
            f'#!/usr/bin/env bash\necho "$@" >> "{self.docker_calls.as_posix()}"\n',
            encoding="utf-8",
            newline="\n",
        )
        fake_docker.chmod(fake_docker.stat().st_mode | stat.S_IEXEC)
        self.path = f"{fake_bin.as_posix()}{os.pathsep}{os.environ['PATH']}"

    def run_installer_sequence(self, body: str) -> subprocess.CompletedProcess:
        script = f'set -euo pipefail; source "{LIB_SH.as_posix()}"; {body}'
        env = {**os.environ, "PATH": self.path}
        return subprocess.run([self.bash, "-c", script], env=env, capture_output=True, text=True)

    def render(self, email: str = "admin@example.com") -> str:
        return f'render_traefik_config "{self.template.as_posix()}" "{self.dest.as_posix()}" "{email}"; restart_traefik_if_config_changed'

    def restarts(self) -> list[str]:
        if not self.docker_calls.exists():
            return []
        return self.docker_calls.read_text(encoding="utf-8").splitlines()

    def test_first_render_writes_the_file_without_restarting(self) -> None:
        result = self.run_installer_sequence(self.render())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.dest.read_text(encoding="utf-8"), 'email: "admin@example.com"\nversion: 1\n')
        self.assertEqual(self.restarts(), [])

    def test_unchanged_render_does_not_restart(self) -> None:
        self.assertEqual(self.run_installer_sequence(self.render()).returncode, 0)
        result = self.run_installer_sequence(self.render())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.restarts(), [])

    def test_changed_render_restarts_traefik_exactly_once(self) -> None:
        self.assertEqual(self.run_installer_sequence(self.render()).returncode, 0)
        self.template.write_text('email: "__ACME_EMAIL__"\nversion: 2\n', encoding="utf-8", newline="\n")

        result = self.run_installer_sequence(self.render())

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.restarts(), ["restart vexlyx-traefik"])
        self.assertIn("version: 2", self.dest.read_text(encoding="utf-8"))

    def test_changed_admin_email_counts_as_a_change(self) -> None:
        self.assertEqual(self.run_installer_sequence(self.render()).returncode, 0)
        result = self.run_installer_sequence(self.render("other@example.com"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.restarts(), ["restart vexlyx-traefik"])

    def test_the_rendered_file_keeps_its_inode(self) -> None:
        if os.name == "nt":
            self.skipTest("inode identity is a POSIX concern")
        self.assertEqual(self.run_installer_sequence(self.render()).returncode, 0)
        before = self.dest.stat().st_ino
        self.template.write_text('email: "__ACME_EMAIL__"\nversion: 3\n', encoding="utf-8", newline="\n")
        self.assertEqual(self.run_installer_sequence(self.render()).returncode, 0)
        self.assertEqual(self.dest.stat().st_ino, before)

    def test_the_restart_is_wired_into_the_installer_steps(self) -> None:
        step7 = (ROOT_DIR / "system/scripts/install/steps/07-render-config.sh").read_text(encoding="utf-8")
        step14 = (ROOT_DIR / "system/scripts/install/steps/14-services-up.sh").read_text(encoding="utf-8")
        self.assertIn("render_traefik_config", step7)
        self.assertIn("restart_traefik_if_config_changed", step14)


if __name__ == "__main__":
    unittest.main()
