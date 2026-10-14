import importlib.util
import io
import json
import subprocess
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "system" / "python" / "postfix_manager.py"
SPEC = importlib.util.spec_from_file_location("postfix_manager", MODULE_PATH)
postfix_manager = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(postfix_manager)


def completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


class TestCompileLmdbMap(unittest.TestCase):
    def test_success_does_not_raise(self):
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=completed(0)) as run:
            postfix_manager._compile_lmdb_map("virtual_mailbox_maps")

        script = run.call_args.args[0][-1]
        self.assertIn("postmap lmdb:/tmp/virtual_mailbox_maps", script)

    def test_script_preserves_chain_status_across_cleanup(self):
        """`rm -f` always succeeds, so the chain's status must be saved first."""
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=completed(0)) as run:
            postfix_manager._compile_lmdb_map("virtual_alias_maps")

        script = run.call_args.args[0][-1]
        self.assertIn("rc=$?", script)
        self.assertTrue(script.rstrip().endswith("exit $rc"))
        self.assertLess(script.index("rc=$?"), script.index("rm -f"))

    def test_nonzero_exit_raises_with_map_name_and_stderr(self):
        failing = completed(1, stderr="postmap: fatal: open database /tmp/x.lmdb: Permission denied")
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=failing):
            with self.assertRaises(postfix_manager.PostfixMapError) as ctx:
                postfix_manager._compile_lmdb_map("virtual_mailbox_maps")

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.map_name, "virtual_mailbox_maps")
        self.assertIn("virtual_mailbox_maps", message)
        self.assertIn("Permission denied", message)
        self.assertEqual(ctx.exception.code, "POSTFIX_MAP_COMPILE_FAILED")

    def test_timeout_raises(self):
        with mock.patch.object(
            postfix_manager.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="docker", timeout=10),
        ):
            with self.assertRaises(postfix_manager.PostfixMapError) as ctx:
                postfix_manager._compile_lmdb_map("virtual_alias_maps")

        self.assertIn("timed out", str(ctx.exception))

    def test_missing_docker_raises(self):
        with mock.patch.object(postfix_manager.subprocess, "run", side_effect=FileNotFoundError("docker")):
            with self.assertRaises(postfix_manager.PostfixMapError) as ctx:
                postfix_manager._compile_lmdb_map("virtual_mailbox_maps")

        self.assertIn("could not run docker", str(ctx.exception))


class TestSyncReportsFailure(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.object(postfix_manager, "get_postfix_dir", return_value=Path(self.tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        sleeper = mock.patch.object(postfix_manager.time, "sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_sync_virtual_domains_propagates_map_failure_and_skips_reload(self):
        failing = completed(1, stderr="postmap failed")
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=failing) as run:
            with self.assertRaises(postfix_manager.PostfixMapError):
                postfix_manager.sync_virtual_domains(["example.com"], ["a@example.com"])

        reloads = [c for c in run.call_args_list if "reload" in c.args[0]]
        self.assertEqual(reloads, [])

    def test_sync_virtual_aliases_propagates_map_failure(self):
        failing = completed(1, stderr="postmap failed")
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=failing):
            with self.assertRaises(postfix_manager.PostfixMapError):
                postfix_manager.sync_virtual_aliases([{"source": "a@example.com", "destinations": ["b@example.com"]}])

    def test_sync_succeeds_when_compile_and_reload_succeed(self):
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=completed(0)):
            result = postfix_manager.sync_virtual_domains(["example.com"], ["a@example.com"])

        self.assertTrue(result["success"])
        self.assertTrue(result["reloaded"])

    def test_main_reports_the_error_code(self):
        failing = completed(1, stderr="postmap failed")
        out = io.StringIO()
        argv = ["postfix_manager.py", "sync_virtual_domains", json.dumps({"domains": ["example.com"], "mailboxes": []})]
        with mock.patch.object(postfix_manager.sys, "argv", argv), mock.patch.object(
            postfix_manager.subprocess, "run", return_value=failing
        ), redirect_stdout(out), self.assertRaises(SystemExit) as ctx:
            postfix_manager.main()

        self.assertEqual(ctx.exception.code, 1)
        payload = json.loads(out.getvalue())
        self.assertEqual(payload["code"], "POSTFIX_MAP_COMPILE_FAILED")
        self.assertIn("virtual_mailbox_maps", payload["error"])


if __name__ == "__main__":
    unittest.main()
