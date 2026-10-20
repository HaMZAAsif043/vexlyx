from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "system/python"))
import mail_state
import mail_state_migrate

SPEC = importlib.util.spec_from_file_location("postfix_manager", ROOT / "system/python/postfix_manager.py")
postfix_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(postfix_manager)


class TestSyncReportsFailure(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        source = root / "source"
        source.mkdir()
        env = mock.patch.dict(os.environ, {"VEXLYX_MAIL_STATE_DIR": str(root / "state")})
        env.start()
        self.addCleanup(env.stop)
        mail_state_migrate.migrate(source, root / "state")
        self.previous = mail_state.active_generation("postfix")

    def fail_prepare(self, component, action, generation=None):
        if action == "prepare":
            raise mail_state.MailStateError("MAIL_STATE_ACTIVATION_FAILED", "postmap failed", component=component, phase=action)

    def test_sync_virtual_domains_propagates_map_failure_and_preserves_active_state(self):
        with mock.patch.object(mail_state, "run_service", side_effect=self.fail_prepare) as run:
            with self.assertRaises(mail_state.MailStateError):
                postfix_manager.sync_virtual_domains(["example.com"], ["a@example.com"])
        self.assertEqual(mail_state.active_generation("postfix"), self.previous)
        self.assertFalse(any(call.args[1] == "activate" for call in run.call_args_list))

    def test_sync_virtual_aliases_propagates_map_failure(self):
        with mock.patch.object(mail_state, "run_service", side_effect=self.fail_prepare):
            with self.assertRaises(mail_state.MailStateError):
                postfix_manager.sync_virtual_aliases([{"source": "a@example.com", "destinations": ["b@example.com"]}])
        self.assertEqual(mail_state.active_generation("postfix"), self.previous)

    def test_sync_succeeds_when_prepare_and_activation_succeed(self):
        with mock.patch.object(mail_state, "run_service"):
            result = postfix_manager.sync_virtual_domains(["example.com"], ["a@example.com"])
        self.assertTrue(result["success"])
        self.assertTrue(result["reloaded"])
        self.assertNotEqual(mail_state.active_generation("postfix"), self.previous)
        self.assertIn("a@example.com example.com/a/Maildir/", mail_state.read_lines("postfix", "virtual_mailbox_maps"))

    def test_main_reports_the_error_code_and_phase(self):
        output = io.StringIO()
        argv = ["postfix_manager.py", "sync_virtual_domains", json.dumps({"domains": ["example.com"], "mailboxes": []})]
        with mock.patch.object(postfix_manager.sys, "argv", argv), mock.patch.object(
            mail_state, "run_service", side_effect=self.fail_prepare
        ), redirect_stdout(output), self.assertRaises(SystemExit) as caught:
            postfix_manager.main()
        self.assertEqual(caught.exception.code, 1)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["code"], "MAIL_STATE_ACTIVATION_FAILED")
        self.assertEqual(payload["details"]["phase"], "prepare")


if __name__ == "__main__":
    unittest.main()
