import gzip
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location(
    "backup_manager", Path(__file__).parents[1] / "system/python/backup_manager.py"
)
backup_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup_manager)

PAYLOAD = {
    "itemId": "db1",
    "dbName": "shop",
    "dbType": "MYSQL",
    "dbUser": "root",
    "dbPassword": "secret",
}


def fake_process(returncode=0, stderr=b"", stdin_error=None):
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate.return_value = (b"", stderr)
    if stdin_error:
        proc.stdin.write.side_effect = stdin_error
    return proc


class MysqlRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / "snapshot.tar.gz"

        def extract(archive, member, dest):
            target = Path(dest) / member
            target.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(target, "wb") as handle:
                handle.write(b"CREATE TABLE t (id INT);")

        self.enterContext(patch.object(backup_manager, "extract_members", side_effect=extract))
        self.enterContext(patch.object(backup_manager, "log_line"))
        self.popen = self.enterContext(patch.object(backup_manager, "popen_docker_exec"))

    def test_creates_a_dropped_database_before_loading_the_dump(self):
        ensure, load = fake_process(), fake_process()
        self.popen.side_effect = [ensure, load]
        result = backup_manager.restore_database(PAYLOAD, self.archive)
        self.assertTrue(result["success"])
        ensure_args = self.popen.call_args_list[0].args[1]
        self.assertIn("CREATE DATABASE IF NOT EXISTS `shop`", ensure_args)
        self.assertEqual(self.popen.call_args_list[1].args[1][-1], "shop")
        load.stdin.write.assert_called_once_with(b"CREATE TABLE t (id INT);")

    def test_client_that_exits_early_reports_its_error_not_a_traceback(self):
        ensure = fake_process()
        load = fake_process(returncode=1, stderr=b"ERROR 1049 Unknown database", stdin_error=BrokenPipeError())
        self.popen.side_effect = [ensure, load]
        with self.assertRaises(SystemExit), patch("builtins.print") as output:
            backup_manager.restore_database(PAYLOAD, self.archive)
        message = output.call_args.args[0]
        self.assertIn("DB_RESTORE_FAILED", message)
        self.assertIn("Unknown database", message)

    def test_streams_the_dump_into_a_real_process_without_closing_stdin_early(self):
        client = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.buffer.read()"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.popen.side_effect = [fake_process(), client]
        result = backup_manager.restore_database(PAYLOAD, self.archive)
        self.assertTrue(result["success"])
        self.assertEqual(client.returncode, 0)

    def test_failure_to_create_the_database_stops_before_loading(self):
        self.popen.side_effect = [fake_process(returncode=1, stderr=b"Access denied")]
        with self.assertRaises(SystemExit), patch("builtins.print") as output:
            backup_manager.restore_database(PAYLOAD, self.archive)
        self.assertEqual(self.popen.call_count, 1)
        self.assertIn("Access denied", output.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
