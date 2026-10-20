import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "system" / "python" / "postfix_manager.py"
SPEC = importlib.util.spec_from_file_location("postfix_manager", MODULE_PATH)
postfix_manager = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(postfix_manager)


class TestReloadOpendkim(unittest.TestCase):
    def test_reloads_tables_with_sigusr1_not_sighup(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(postfix_manager.subprocess, "run", return_value=completed) as run:
            postfix_manager.reload_opendkim()
        command = run.call_args.args[0]
        self.assertEqual(command[-3:], ["pkill", "-USR1", "opendkim"])
        self.assertNotIn("-HUP", command)

    def test_a_failing_reload_does_not_break_the_caller(self):
        with mock.patch.object(postfix_manager.subprocess, "run", side_effect=OSError("docker missing")):
            postfix_manager.reload_opendkim()


if __name__ == "__main__":
    unittest.main()
