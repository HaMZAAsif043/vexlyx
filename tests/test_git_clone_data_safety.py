import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "git_manager", Path(__file__).parents[1] / "system/python/git_manager.py"
)
git_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(git_manager)

URL = "https://github.com/team/repo"
OTHER_URL = "https://github.com/team/other"


def completed(code=0, out="", err=""):
    return subprocess.CompletedProcess([], code, out, err)


class GitCloneDataSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.projects = Path(self.temp.name)
        self.workspace = self.projects / "test"
        self.workspace.mkdir()
        (self.workspace / ".git").mkdir()
        (self.workspace / "uploads.txt").write_text("customer data")
        self.payload = {"projectId": "test", "projectsDir": self.temp.name, "gitUrl": URL}
        self.printed = self.enterContext(patch("builtins.print"))
        self.configured_origin = URL
        self.failing_verb = None
        self.enterContext(patch.object(git_manager.subprocess, "run", side_effect=self.fake_run))

    def fake_run(self, args, **_):
        if "config" in args:
            return completed(out=self.configured_origin + "\n")
        if self.failing_verb and self.failing_verb in args:
            return completed(1, err="boom")
        if "clone" in args:
            destination = Path(args[-1])
            destination.mkdir()
            (destination / "README.md").write_text("fresh clone")
        return completed()

    def last_output(self):
        return json.loads(self.printed.call_args.args[0])

    def test_failed_pull_keeps_every_file_and_reports_the_error(self):
        for verb in ("fetch", "checkout", "pull"):
            with self.subTest(verb=verb):
                self.failing_verb = verb
                with self.assertRaises(git_manager.GitCommandError) as caught:
                    git_manager.cmd_clone(self.payload)
                self.assertEqual(caught.exception.code, "COMMAND_FAILED")
                self.assertEqual((self.workspace / "uploads.txt").read_text(), "customer data")
                self.assertTrue((self.workspace / ".git").is_dir())
                self.assertEqual([p.name for p in self.projects.iterdir()], ["test"])

    def test_switching_repository_keeps_the_old_workspace_aside(self):
        self.failing_verb = "pull"
        self.configured_origin = OTHER_URL
        git_manager.cmd_clone(self.payload)
        output = self.last_output()
        self.assertEqual(output["action"], "cloned")
        self.assertEqual((self.workspace / "README.md").read_text(), "fresh clone")
        kept = Path(output["previousWorkspace"])
        self.assertEqual((kept / "uploads.txt").read_text(), "customer data")

    def test_first_clone_into_a_workspace_without_git_keeps_existing_files(self):
        (self.workspace / ".git").rmdir()
        git_manager.cmd_clone(self.payload)
        output = self.last_output()
        self.assertEqual((Path(output["previousWorkspace"]) / "uploads.txt").read_text(), "customer data")
        self.assertEqual((self.workspace / "README.md").read_text(), "fresh clone")

    def test_clone_into_an_empty_workspace_leaves_nothing_behind(self):
        (self.workspace / ".git").rmdir()
        (self.workspace / "uploads.txt").unlink()
        git_manager.cmd_clone(self.payload)
        self.assertNotIn("previousWorkspace", self.last_output())
        self.assertEqual([p.name for p in self.projects.iterdir()], ["test"])

    def test_failed_clone_restores_the_previous_workspace(self):
        (self.workspace / ".git").rmdir()
        self.failing_verb = "clone"
        with self.assertRaises(git_manager.GitCommandError):
            git_manager.cmd_clone(self.payload)
        self.assertEqual((self.workspace / "uploads.txt").read_text(), "customer data")
        self.assertEqual([p.name for p in self.projects.iterdir()], ["test"])


if __name__ == "__main__":
    unittest.main()
