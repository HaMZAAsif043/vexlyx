"""Branch switching on an existing workspace (#153).

A workspace cloned with `--single-branch` pins remote.origin.fetch to the
originally cloned branch, so a branch created after the clone never appears
in refs/remotes/origin/ and `git checkout <branch>` fails with
"pathspec ... did not match".  These tests lock in the explicit-refspec
fetch + wildcard refspec restore + `checkout -b` from the remote-tracking
ref, and the single-JSON-document contract the API caller depends on.
"""

import importlib.util
import io
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


def completed(args, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout, stderr)


def tail(args):
    """Command arguments without the leading git/binary and redirect guard."""
    out = list(args)
    while out and out[0] in ("git", "ssh-keygen", "-c", "http.followRedirects=false", "-C"):
        if out[0] == "-C":
            out = out[2:]
            break
        out = out[1:]
    return out


def run_commands(calls):
    """Subprocess invocations excluding the read-only rev-parse probes."""
    return [tail(call.args[0]) for call in calls if "rev-parse" not in call.args[0]]


class CheckoutFetchedBranchTests(unittest.TestCase):
    """Unit tests for the branch-switch helper itself."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dest = Path(self.temp.name) / "workspace"
        self.dest.mkdir()
        self.run = self.enterContext(patch.object(git_manager.subprocess, "run"))

    def _script(self, ref_exists, run_rc=0):
        """Route mocked subprocess.run calls by command shape."""

        def side_effect(args, **kwargs):
            if "rev-parse" in args:
                ref = args[-1]
                return completed(args, 0 if ref_exists.get(ref, False) else 1)
            return completed(args, run_rc)

        self.run.side_effect = side_effect

    def test_existing_local_branch_is_checked_out_directly(self):
        self._script({"refs/heads/feature-x": True})
        git_manager._checkout_fetched_branch(self.dest, "feature-x", None)
        commands = run_commands(self.run.call_args_list)
        self.assertEqual(commands, [["checkout", "feature-x"]])

    def test_new_branch_is_fetched_with_explicit_refspec_then_checked_out(self):
        # Neither the local branch nor the remote-tracking ref exists: the
        # single-branch clone's pinned refspec would hide the new branch.
        self._script({})
        git_manager._checkout_fetched_branch(self.dest, "feature-x", None)
        commands = run_commands(self.run.call_args_list)
        self.assertEqual(
            commands[0],
            ["fetch", "origin", "+refs/heads/feature-x:refs/remotes/origin/feature-x"],
        )
        self.assertEqual(
            commands[1],
            ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        )
        self.assertEqual(
            commands[2],
            ["checkout", "-b", "feature-x", "refs/remotes/origin/feature-x"],
        )

    def test_already_fetched_branch_skips_fetch_and_uses_tracking_ref(self):
        self._script({"refs/remotes/origin/feature-x": True})
        git_manager._checkout_fetched_branch(self.dest, "feature-x", None)
        commands = run_commands(self.run.call_args_list)
        self.assertEqual(
            commands,
            [["checkout", "-b", "feature-x", "refs/remotes/origin/feature-x"]],
        )

    def test_fetch_failure_raises_instead_of_printing(self):
        def side_effect(args, **kwargs):
            if "rev-parse" in args:
                return completed(args, 1)
            if "fetch" in args:
                return completed(args, 128, stderr="couldn't find remote ref")
            return completed(args, 0)

        self.run.side_effect = side_effect
        printed = self.enterContext(patch("builtins.print"))
        with self.assertRaises(git_manager.GitCommandError):
            git_manager._checkout_fetched_branch(self.dest, "nope", None)
        printed.assert_not_called()


class BranchValidationTests(unittest.TestCase):
    """The API schema only bounds branch length; unsafe names must be rejected."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.run = self.enterContext(patch.object(git_manager.subprocess, "run"))
        self.run.return_value = completed([], 0)
        self.print = self.enterContext(patch("builtins.print"))

    def test_rejects_unsafe_branch_names_before_any_command(self):
        for branch in (
            "-b", "--upload-pack=touch", "feature x", "feature\nx", "a..b",
            "a//b", "a.lock", "a\\b", "a^b", "a~b", "a:b", "a?b", "a*b",
            "a[b", "a@{b", "/leading", "trailing/", "trailing.", "",
        ):
            with self.subTest(branch=branch):
                self.print.reset_mock()
                payload = {
                    "command": "clone",
                    "projectId": "test",
                    "projectsDir": self.temp.name,
                    "gitUrl": "https://github.com/team/repo",
                    "branch": branch,
                }
                with self.assertRaises(SystemExit) as ctx:
                    git_manager.cmd_clone(payload)
                self.assertEqual(ctx.exception.code, 1)
                emitted = json.loads(self.print.call_args.args[0])
                self.assertEqual(emitted["code"], "INVALID_BRANCH")
        self.run.assert_not_called()

    def test_accepts_ordinary_branch_names(self):
        for branch in ("main", "develop", "feature/x-1.0", "release_2024"):
            with self.subTest(branch=branch):
                git_manager._validate_branch(branch)


class SingleDocumentContractTests(unittest.TestCase):
    """The caller JSON.parses the whole stdout; exactly one document per call."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.payload = {
            "command": "clone",
            "projectId": "test",
            "projectsDir": self.temp.name,
            "gitUrl": "https://github.com/team/repo",
            "branch": "feature-x",
        }
        self.run = self.enterContext(patch.object(git_manager.subprocess, "run"))
        self.print = self.enterContext(patch("builtins.print"))

    def _commands(self):
        return [" ".join(call.args[0]) for call in self.run.call_args_list]

    def test_failed_update_falls_back_to_reclone_with_one_document(self):
        (Path(self.temp.name) / "test" / ".git").mkdir(parents=True)

        def side_effect(args, **kwargs):
            # The update path fails the way a branch switch used to: fetch
            # succeeds, but checkout reports the branch as unknown.
            if "fetch" in args:
                return completed(args, 0)
            if "checkout" in args or "pull" in args:
                return completed(
                    args, 128, stderr="error: pathspec 'feature-x' did not match"
                )
            return completed(args, 0)

        self.run.side_effect = side_effect
        git_manager.cmd_clone(self.payload)
        self.assertEqual(self.print.call_count, 1)
        emitted = json.loads(self.print.call_args.args[0])
        self.assertTrue(emitted["success"])
        self.assertEqual(emitted["action"], "cloned")
        # The failed workspace was wiped before the re-clone.
        self.assertTrue(any("clone" in c for c in self._commands()))

    def test_failed_clone_reports_one_error_document(self):
        def side_effect(args, **kwargs):
            if "clone" in args:
                return completed(args, 128, stderr="Remote branch not found")
            return completed(args, 0)

        self.run.side_effect = side_effect
        with self.assertRaises(git_manager.GitCommandError):
            git_manager.cmd_clone(self.payload)
        self.print.assert_not_called()

    def test_main_turns_command_failure_into_one_error_document(self):
        def side_effect(args, **kwargs):
            if "clone" in args:
                return completed(args, 128, stderr="clone refused")
            return completed(args, 0)

        self.run.side_effect = side_effect
        self.enterContext(
            patch.object(git_manager.sys, "stdin", io.StringIO(json.dumps(self.payload)))
        )
        with self.assertRaises(SystemExit) as ctx:
            git_manager.main()
        self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(self.print.call_count, 1)
        emitted = json.loads(self.print.call_args.args[0])
        self.assertIn("error", emitted)
        self.assertEqual(emitted["code"], "COMMAND_FAILED")

    def test_successful_update_still_reports_single_pull_document(self):
        (Path(self.temp.name) / "test" / ".git").mkdir(parents=True)

        def side_effect(args, **kwargs):
            if "rev-parse" in args:
                # Local branch already exists.
                return completed(args, 0 if args[-1] == "refs/heads/main" else 1)
            return completed(args, 0)

        self.run.side_effect = side_effect
        payload = {**self.payload, "branch": "main"}
        git_manager.cmd_clone(payload)
        self.assertEqual(self.print.call_count, 1)
        emitted = json.loads(self.print.call_args.args[0])
        self.assertEqual(emitted["action"], "pulled")


if __name__ == "__main__":
    unittest.main()
