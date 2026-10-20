import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "system" / "python" / "postfix_manager.py"
SPEC = importlib.util.spec_from_file_location("postfix_manager", MODULE_PATH)
postfix_manager = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(postfix_manager)


class TestReloadOpendkim(unittest.TestCase):
    def run_reload(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=completed) as run:
            postfix_manager.reload_opendkim()
        return run.call_args.args[0]

    def test_runs_inside_the_postfix_container(self):
        command = self.run_reload()
        self.assertEqual(command[:5], ["docker", "exec", "vexlyx-postfix", "sh", "-c"])

    def test_reloads_with_sigusr1_because_sighup_makes_the_signer_exit(self):
        script = self.run_reload()[5]
        self.assertIn("pkill -USR1 opendkim", script)
        self.assertNotIn("-HUP", script)

    def test_fixes_key_ownership_and_modes_before_the_reload(self):
        script = self.run_reload()[5]
        self.assertIn("chown -R opendkim:opendkim /etc/opendkim/keys", script)
        self.assertIn("chmod 600", script)
        self.assertLess(script.index("chown"), script.index("pkill"))
        self.assertLess(script.index("chmod 600"), script.index("pkill"))

    def test_a_failing_reload_does_not_break_the_caller(self):
        with mock.patch.object(postfix_manager.subprocess, "run", side_effect=OSError("docker missing")):
            postfix_manager.reload_opendkim()


class TestGeneratedKeyPermissions(unittest.TestCase):
    def test_private_key_is_not_readable_by_others(self):
        if os.name == "nt":
            self.skipTest("POSIX file modes are not meaningful on Windows")
        if not postfix_manager.HAVE_CRYPTO:
            self.skipTest("cryptography is required")
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(postfix_manager, "get_dkim_dir", return_value=Path(directory)),                     mock.patch.object(postfix_manager, "update_opendkim_tables"):
                postfix_manager.generate_dkim_keys("example.org", key_size=2048)
            private_key = Path(directory) / "keys" / "example.org" / "default.private"
            self.assertEqual(private_key.stat().st_mode & 0o077, 0)


if __name__ == "__main__":
    unittest.main()
