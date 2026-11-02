"""DKIM key lifecycle behind the first mail-authentication check (#159).

The API's check reads the key first (get_dkim) and creates it only when absent
(generate_dkim). These tests pin the properties that makes safe: reading never
creates, creating is idempotent and never rotates, the private key is not
readable by others, and OpenDKIM is told to reload with SIGUSR1.
"""

import hashlib
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).parents[1] / "system" / "python" / "postfix_manager.py"
# postfix_manager imports its sibling mail_state; run as a script that is
# implicit, loaded from a test it is not.
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("postfix_manager_first_check", MODULE_PATH)
postfix_manager = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(postfix_manager)

DOMAIN = "fresh.example"


class FirstCheckKeyLifecycleTest(unittest.TestCase):
    def setUp(self):
        if not postfix_manager.HAVE_CRYPTO:
            self.skipTest("cryptography is required")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state = Path(self._tmp.name)
        patch = mock.patch.object(postfix_manager, "get_dkim_dir", return_value=self.state)
        patch.start()
        self.addCleanup(patch.stop)
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        run = mock.patch.object(postfix_manager.subprocess, "run", return_value=completed)
        self.run_mock = run.start()
        self.addCleanup(run.stop)

    def private_key(self) -> Path:
        return self.state / "keys" / DOMAIN / "default.private"

    def test_reading_a_domain_without_a_key_does_not_create_one(self):
        result = postfix_manager.get_dkim_record(DOMAIN, "default")
        self.assertFalse(result["found"])
        self.assertFalse(self.private_key().exists())

    def test_generating_makes_the_record_readable_afterwards(self):
        created = postfix_manager.generate_dkim_keys(DOMAIN, "default", 2048)
        self.assertTrue(created["isNew"])
        read = postfix_manager.get_dkim_record(DOMAIN, "default")
        self.assertTrue(read["found"])
        self.assertEqual(read["dnsRecordValue"], created["dnsRecordValue"])
        self.assertEqual(read["dnsRecordName"], f"default._domainkey.{DOMAIN}")

    def test_a_second_call_returns_the_same_key_and_never_rotates_it(self):
        first = postfix_manager.generate_dkim_keys(DOMAIN, "default", 2048)
        digest = hashlib.sha256(self.private_key().read_bytes()).hexdigest()

        second = postfix_manager.generate_dkim_keys(DOMAIN, "default", 2048)

        self.assertFalse(second["isNew"])
        self.assertEqual(second["dnsRecordValue"], first["dnsRecordValue"])
        self.assertEqual(second["publicKey"], first["publicKey"])
        self.assertEqual(hashlib.sha256(self.private_key().read_bytes()).hexdigest(), digest)

    def test_the_private_key_is_not_accessible_to_group_or_others(self):
        if os.name == "nt":
            self.skipTest("POSIX file modes are not meaningful on Windows")
        postfix_manager.generate_dkim_keys(DOMAIN, "default", 2048)
        self.assertEqual(self.private_key().stat().st_mode & 0o777, 0o600)

    def test_creating_a_key_reloads_opendkim_with_sigusr1_and_never_sighup(self):
        postfix_manager.generate_dkim_keys(DOMAIN, "default", 2048)
        scripts = [call.args[0][5] for call in self.run_mock.call_args_list if call.args and len(call.args[0]) > 5]
        self.assertTrue(scripts, "OpenDKIM was never told to reload")
        for script in scripts:
            self.assertIn("pkill -USR1 opendkim", script)
            self.assertNotIn("-HUP", script)

    def test_the_new_domain_is_registered_for_signing(self):
        postfix_manager.generate_dkim_keys(DOMAIN, "default", 2048)
        self.assertIn(f"*@{DOMAIN} default._domainkey.{DOMAIN}", (self.state / "SigningTable").read_text())
        self.assertIn(f"default._domainkey.{DOMAIN} {DOMAIN}:default:/etc/opendkim/keys/{DOMAIN}/default.private",
                      (self.state / "KeyTable").read_text())


if __name__ == "__main__":
    unittest.main()
