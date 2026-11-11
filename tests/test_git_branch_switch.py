"""
#153 — switching a project to a branch that did not exist when its workspace was
first cloned.

These run the real git binary. The failure is git's own refspec behaviour: a
`--single-branch` clone restricts `remote.origin.fetch`, and mocked subprocess
calls cannot show that a plain fetch therefore never learns of a new branch, nor
that `checkout` refuses to guess a branch even once its remote-tracking ref
exists. The local repository is rewired behind a public URL, so the tested URL
policy in git_manager.py stays exactly as strict as it is in production.
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
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "git_manager", Path(__file__).parents[1] / "system/python/git_manager.py"
)
git_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(git_manager)

URL = "https://github.com/team/repo"
NEW_BRANCH = "vexlyx-docker"

GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "Vexlyx test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Vexlyx test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


class GitBranchSwitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = self.root / "projects"
        self.projects.mkdir()
        self.workspace = self.projects / "p1"

        self.origin = self.root / "origin.git"
        self.git("init", "-q", "--initial-branch=main", "--bare", str(self.origin))
        self.seed = self.root / "seed"
        self.git("init", "-q", "--initial-branch=main", str(self.seed))
        self.write_file(self.seed, "main.txt", "work on main\n")
        self.git("-C", str(self.seed), "remote", "add", "origin", self.origin.as_uri())
        self.git("-C", str(self.seed), "push", "-q", "origin", "main")

        config = self.root / "gitconfig"
        config.write_text(f'[url "{self.origin.as_uri()}"]\n\tinsteadOf = {URL}\n')
        previous = os.environ.get("GIT_CONFIG_GLOBAL")
        os.environ["GIT_CONFIG_GLOBAL"] = str(config)
        self.addCleanup(self.restore_config, previous)

    def restore_config(self, previous):
        if previous is None:
            os.environ.pop("GIT_CONFIG_GLOBAL", None)
        else:
            os.environ["GIT_CONFIG_GLOBAL"] = previous

    def git(self, *args):
        env = {**os.environ, **GIT_IDENTITY}
        result = subprocess.run(
            ["git", *args], capture_output=True, text=True, env=env, timeout=120,
            cwd=str(self.root),
        )
        if result.returncode != 0:
            self.fail(f"git {' '.join(args)} failed: {result.stderr or result.stdout}")
        return result.stdout

    def write_file(self, repo: Path, name: str, content: str):
        (repo / name).write_text(content)
        self.git("-C", str(repo), "add", name)
        self.git("-C", str(repo), "commit", "-qm", f"add {name}")

    def run_sync(self, branch: str, git_url: str = URL) -> dict:
        """Exercise the real entry point, including its error-to-JSON boundary."""
        result = subprocess.run(
            [sys.executable, str(Path(__file__).parents[1] / "system/python/git_manager.py")],
            input=json.dumps({
                "command": "clone", "projectId": "p1", "projectsDir": str(self.projects),
                "gitUrl": git_url, "branch": branch,
            }), capture_output=True, text=True, timeout=120,
        )
        documents = [line for line in result.stdout.splitlines() if line.strip()]
        self.assertEqual(
            len(documents), 1,
            f"git_manager.py must answer with one JSON document, got {documents}",
        )
        document = json.loads(documents[0])
        self.assertEqual(
            result.returncode != 0, not document.get("success"),
            f"exit status and reported result disagree: {document}",
        )
        return document

    def sync(self, branch: str) -> dict:
        document = self.run_sync(branch)
        self.assertTrue(document.get("success"), document)
        return document

    def publish_new_branch(self):
        self.git("-C", str(self.seed), "checkout", "-q", "-b", NEW_BRANCH, "main")
        self.write_file(self.seed, "dockerfile.txt", "work on the new branch\n")
        self.git("-C", str(self.seed), "push", "-q", "origin", NEW_BRANCH)
        self.git("-C", str(self.seed), "checkout", "-q", "main")

    def test_first_clone_is_a_single_branch_clone(self):
        # The setup the bug depends on: afterwards only main is fetchable.
        self.assertEqual(self.sync("main")["action"], "cloned")
        refspec = self.git("-C", str(self.workspace), "config", "--get", "remote.origin.fetch")
        self.assertEqual(refspec.strip(), "+refs/heads/main:refs/remotes/origin/main")

    def test_switching_to_a_branch_created_after_the_clone(self):
        self.sync("main")
        self.publish_new_branch()

        self.assertEqual(self.sync(NEW_BRANCH)["action"], "pulled")
        self.assertEqual(
            (self.workspace / "dockerfile.txt").read_text(), "work on the new branch\n"
        )
        tracked = self.git("-C", str(self.workspace), "rev-parse", "--abbrev-ref", "@{upstream}")
        self.assertEqual(tracked.strip(), f"origin/{NEW_BRANCH}")

    def test_switching_back_to_the_original_branch_still_works(self):
        self.sync("main")
        self.publish_new_branch()
        self.sync(NEW_BRANCH)

        self.assertEqual(self.sync("main")["action"], "pulled")
        self.assertEqual(
            self.git("-C", str(self.workspace), "rev-parse", "--abbrev-ref", "HEAD").strip(),
            "main",
        )

    def test_an_unknown_branch_is_one_clear_error_and_never_a_re_clone(self):
        self.sync("main")
        (self.workspace / "uploads.txt").write_text("customer data")

        document = self.run_sync("no-such-branch")
        self.assertEqual(document["code"], "COMMAND_FAILED")
        self.assertIn("no-such-branch", document["error"])
        # A failed sync must leave the workspace exactly where it was.
        self.assertTrue((self.workspace / "uploads.txt").exists())
        self.assertTrue((self.workspace / ".git").is_dir())

    def test_repository_change_fallback_emits_one_document_and_preserves_uploads(self):
        self.sync("main")
        (self.workspace / "uploads.txt").write_text("customer data")
        other = self.root / "other"
        self.git("init", "-q", "--initial-branch=main", str(other))
        self.write_file(other, "different.txt", "unrelated repository\n")
        other_url = "https://github.com/team/other"
        self.git("config", "--global", "--add", f"url.{other.as_uri()}.insteadOf", other_url)
        document = self.run_sync("main", other_url)
        self.assertTrue(document.get("success"), document)
        self.assertEqual(document["action"], "cloned")
        self.assertEqual((self.workspace / "different.txt").read_text(), "unrelated repository\n")
        self.assertEqual((Path(document["previousWorkspace"]) / "uploads.txt").read_text(), "customer data")


if __name__ == "__main__":
    unittest.main()
