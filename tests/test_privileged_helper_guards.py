"""Run real firewall/SFTP guard logic with all privileged subprocesses simulated."""
import importlib.util
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / "system/python" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


firewall = load("firewall_manager")
sftp = load("sftp_manager")


class PrivilegedGuardTests(unittest.TestCase):
    def test_protected_deny_never_executes_ufw(self):
        for port in (22, 8443):
            with self.subTest(port=port), patch.object(firewall, "run_ufw") as run, redirect_stdout(StringIO()), self.assertRaises(SystemExit) as stopped:
                firewall.cmd_add_rule({"port": port, "action": "DENY", "protocol": "TCP", "panelPort": 8443})
            self.assertEqual(stopped.exception.code, 1)
            run.assert_not_called()

    def test_protected_allow_cannot_be_removed(self):
        with patch.object(firewall, "run_ufw") as run, redirect_stdout(StringIO()), self.assertRaises(SystemExit):
            firewall.cmd_delete_rule({"port": 22, "action": "ALLOW", "protocol": "TCP"})
        run.assert_not_called()

    def test_default_deny_stops_after_status_when_no_protected_allow_exists(self):
        with patch.object(firewall, "IS_LINUX", True), patch.object(firewall, "run_ufw", return_value="Status: inactive") as run, redirect_stdout(StringIO()), self.assertRaises(SystemExit):
            firewall.cmd_set_default_policy({"defaultIncoming": "deny", "defaultOutgoing": "allow"})
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[1], ["status", "verbose"])

    def test_failed_ufw_process_does_not_report_success(self):
        with patch.object(firewall, "IS_LINUX", True), patch.object(firewall, "get_docker_binary", return_value="docker"), patch.object(firewall.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "denied")), patch.object(firewall, "respond") as respond, redirect_stdout(StringIO()), self.assertRaises(SystemExit):
            firewall.cmd_add_rule({"port": 8080, "action": "ALLOW", "protocol": "TCP"})
        respond.assert_not_called()

    def test_invalid_sftp_user_never_reaches_chpasswd(self):
        with patch.object(sftp.subprocess, "run") as run, redirect_stdout(StringIO()), self.assertRaises(SystemExit):
            sftp.cmd_rotate_password({"linuxUsername": "root", "password": "test"})
        run.assert_not_called()

    def test_password_failure_does_not_report_success(self):
        with patch.object(sftp, "IS_POSIX", True), patch.object(sftp.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "denied")) as run, patch.object(sftp, "ok") as ok, redirect_stdout(StringIO()), self.assertRaises(SystemExit):
            sftp.cmd_rotate_password({"linuxUsername": "vsftp_abcdefgh", "password": "test-password"})
        ok.assert_not_called()
        self.assertEqual(run.call_args.args[0], ["sudo", "chpasswd"])
        self.assertEqual(run.call_args.kwargs["input"], "vsftp_abcdefgh:test-password")

    def test_useradd_failure_aborts_before_password_or_project_mounts(self):
        commands = []
        def command(args, **_kwargs):
            commands.append(args)
            if "useradd" in args:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 1 if "id" in args else 0, "", "")
        with tempfile.TemporaryDirectory() as directory, patch.object(sftp, "IS_POSIX", True), patch.object(sftp.subprocess, "run", side_effect=command), patch.object(sftp, "sync_user_projects") as sync, patch.object(sftp, "ok") as ok, self.assertRaises(subprocess.CalledProcessError):
            sftp.cmd_provision({"userId": "abcdefgh", "password": "test-password", "chrootDir": directory, "projects": []})
        self.assertTrue(any("useradd" in args for args in commands))
        self.assertFalse(any("chpasswd" in args for args in commands))
        sync.assert_not_called()
        ok.assert_not_called()


if __name__ == "__main__":
    unittest.main()
