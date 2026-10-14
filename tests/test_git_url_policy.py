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


class GitUrlPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.payload = {"projectId": "test", "projectsDir": self.temp.name}
        self.run = self.enterContext(patch.object(git_manager.subprocess, "run"))
        self.run.return_value = subprocess.CompletedProcess([], 0, "", "")
        self.print = self.enterContext(patch("builtins.print"))

    def test_rejects_unsafe_url_before_commands_or_workspace_changes(self):
        workspace = Path(self.temp.name) / "test"
        workspace.mkdir()
        sentinel = workspace / "keep.txt"
        sentinel.write_text("unchanged")
        for url in (
            "file:///private/repository", "http://169.254.169.254/repo",
            "https://example.com/team/repo", "ssh://internal/team/repo",
            "git://github.com/team/repo", "https://github.com:8080/team/repo",
            "https://github.com@localhost/team/repo", "https://github.com.evil.example/team/repo",
            "https://github.com/team/repo\n", "https://github.com\\@localhost/team/repo",
        ):
            with self.subTest(url=url):
                self.print.reset_mock()
                with self.assertRaises(SystemExit) as ctx:
                    git_manager.cmd_clone({**self.payload, "gitUrl": url})
                self.assertEqual(ctx.exception.code, 1)
                emitted = json.loads(self.print.call_args.args[0])
                self.assertEqual(emitted["code"], "INVALID_GIT_URL")
                self.assertIn("error", emitted)
        self.run.assert_not_called()
        self.assertEqual(sentinel.read_text(), "unchanged")

    def test_supported_clone_uses_validated_url_and_disables_redirects(self):
        for url in ("https://github.com/team/repo.git", "https://gitlab.com/team/group/repo", "git@bitbucket.org:team/repo.git"):
            with self.subTest(url=url):
                git_manager.cmd_clone({**self.payload, "gitUrl": url})
                args = self.run.call_args.args[0]
                self.assertEqual(args[:3], ["git", "-c", "http.followRedirects=false"])
                self.assertIn(url, args)

    def test_existing_workspace_fetches_only_validated_origin(self):
        (Path(self.temp.name) / "test" / ".git").mkdir(parents=True)
        git_manager.cmd_clone({**self.payload, "gitUrl": "https://github.com/team/repo"})
        commands = [call.args[0] for call in self.run.call_args_list]
        self.assertEqual(commands[0][-4:], ["remote", "set-url", "origin", "https://github.com/team/repo"])
        self.assertEqual(commands[1][-2:], ["fetch", "origin"])


if __name__ == "__main__":
    unittest.main()
