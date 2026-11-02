"""
Install-command tests for build_manager.py.

Covers F5.34: the `--install-cmd` flag existed in build_manager.py but nothing
above it ever sent a value, so a project whose dependencies install wrong had
no way to say so from the dashboard.

Run with: python tests/test_build_install_command.py
"""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "build_manager", Path(__file__).parents[1] / "system/python/build_manager.py"
)
build_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_manager)


class FakeProcess:
    """Stand-in for a Popen that finished successfully with no output."""

    def __init__(self):
        self.returncode = 0
        self.stdout = iter(())

    def wait(self):
        return 0

    def poll(self):
        return 0


def emitted(print_mock):
    """Every JSON object a command wrote to stdout, in order."""
    return [json.loads(call.args[0]) for call in print_mock.call_args_list if call.args]


def log_lines(print_mock):
    return [obj["log"] for obj in emitted(print_mock) if "log" in obj]


class DeriveInstallCmdTests(unittest.TestCase):
    """The lockfile heuristics that replaced the copy inlined in cmd_build."""

    def project(self, *files, **contents):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for name in files:
            (root / name).write_text(contents.get(name, "{}"), encoding="utf-8")
        return root

    def test_each_lockfile_selects_its_package_manager(self):
        cases = {
            "pnpm-lock.yaml": "pnpm install",
            "yarn.lock": "yarn install",
            "bun.lockb": "bun install",
            "bun.lock": "bun install",
            "package-lock.json": None,
        }
        for lockfile, expected in cases.items():
            with self.subTest(lockfile=lockfile):
                root = self.project(lockfile)
                self.assertEqual(
                    build_manager.derive_install_cmd(root, "NODEJS"), expected
                )

    def test_bun_wins_over_the_other_lockfiles(self):
        root = self.project("bun.lockb", "pnpm-lock.yaml", "yarn.lock")
        self.assertEqual(build_manager.derive_install_cmd(root, "NODEJS"), "bun install")

    def test_python_gets_a_venv_and_pinned_setuptools(self):
        root = self.project("requirements.txt")
        cmd = build_manager.derive_install_cmd(root, "PYTHON")
        self.assertIn("python -m venv", cmd)
        self.assertIn("pip install 'setuptools<70'", cmd)
        self.assertIn("pip install -r requirements.txt", cmd)

        root = self.project("pyproject.toml")
        self.assertTrue(
            build_manager.derive_install_cmd(root, "PYTHON").endswith("pip install .")
        )

    def test_python_without_a_manifest_falls_back_to_none_not_to_node(self):
        # A Python project with no requirements.txt must not inherit an npm
        # install just because the node heuristics sit below it.
        root = self.project("manage.py")
        self.assertIsNone(build_manager.derive_install_cmd(root, "PYTHON"))

    # Dockerfile projects never reach this helper — cmd_plan returns early and
    # cmd_build takes the `docker build` branch. That is covered where it is
    # actually decided, in PlanReportsInstallCommandTests below.


class PlanReportsInstallCommandTests(unittest.TestCase):
    """cmd_plan has to expose the proposal so the dashboard can show it."""

    def run_plan(self, root):
        with patch.object(build_manager, "get_nixpacks_binary", return_value="nixpacks"), patch.object(
            build_manager,
            "run_bounded",
            return_value=subprocess.CompletedProcess([], 0, "{}", ""),
        ), patch("builtins.print") as printer:
            build_manager.cmd_plan({"projectDir": str(root)})
            return emitted(printer)

    def test_plan_includes_the_detected_install_command(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "package.json").write_text(
            json.dumps(
                {"name": "web", "scripts": {"build": "next build", "start": "next start"}}
            ),
            encoding="utf-8",
        )
        (root / "next.config.js").write_text("module.exports = {};", encoding="utf-8")
        (root / "pnpm-lock.yaml").write_text("", encoding="utf-8")

        plan = self.run_plan(root)[-1]
        self.assertEqual(plan["installCmd"], "pnpm install")
        self.assertEqual(plan["buildCmd"], "pnpm run build")
        self.assertEqual(plan["detectedType"], "NEXTJS")

    def test_plan_keeps_install_cmd_out_for_a_dockerfile_project(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "Dockerfile").write_text("FROM node:20\n", encoding="utf-8")

        plan = self.run_plan(root)[-1]
        self.assertEqual(plan["framework"], "dockerfile")
        self.assertIsNone(plan["installCmd"])


class BuildForwardsInstallCommandTests(unittest.TestCase):
    """The flag reached Nixpacks' command line — the gap F5.34 closes."""

    def node_project(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "package.json").write_text(
            json.dumps({"name": "api", "scripts": {"build": "npm run build", "start": "node server.js"}}),
            encoding="utf-8",
        )
        (root / "server.js").write_text("", encoding="utf-8")
        (root / "package-lock.json").write_text("{}", encoding="utf-8")
        return root

    def run_build(self, root, payload_extra):
        payload = {
            "projectDir": str(root),
            "imageName": "vexlyx-test",
            **payload_extra,
        }
        with patch.object(build_manager, "get_nixpacks_binary", return_value="nixpacks"), patch.object(
            build_manager.subprocess, "Popen", return_value=FakeProcess()
        ) as popen, patch.object(
            build_manager, "stream_with_deadline", return_value=False
        ), patch.object(
            build_manager, "_group_popen_kwargs", return_value={}
        ), patch("builtins.print"):
            build_manager.cmd_build(payload)
            return popen.call_args[0][0]

    def flag_value(self, cmd, flag):
        return cmd[cmd.index(flag) + 1] if flag in cmd else None

    def test_explicit_override_is_passed_through(self):
        cmd = self.run_build(self.node_project(), {"installCmd": "npm ci --omit=dev"})
        self.assertEqual(self.flag_value(cmd, "--install-cmd"), "npm ci --omit=dev")

    def test_no_override_falls_back_to_the_lockfile_heuristic(self):
        root = self.node_project()
        (root / "pnpm-lock.yaml").write_text("", encoding="utf-8")
        cmd = self.run_build(root, {})
        self.assertEqual(self.flag_value(cmd, "--install-cmd"), "pnpm install")

    def test_plain_npm_project_sends_no_install_flag_at_all(self):
        # Absent, not empty: an empty --install-cmd would suppress Nixpacks'
        # own default instead of using it.
        cmd = self.run_build(self.node_project(), {})
        self.assertNotIn("--install-cmd", cmd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
