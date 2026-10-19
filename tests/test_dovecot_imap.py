"""
test_dovecot_imap.py -- Automated test suite for F4.2 Dovecot IMAP Server.

Tests:
1. Dovecot virtual mailbox synchronization (system/python/dovecot_manager.py).
2. Sync preserves passwd-file entries belonging to domains outside the sync scope.
3. Status inspection response schema.
4. Dovecot configuration validation (dovecot.conf, Dockerfile, entrypoint.sh).
5. Postfix <-> Dovecot SASL integration wiring (main.cf, docker-compose.yml).
6. Production host installer script.
7. Live IMAPS login (skipped gracefully if the dev stack isn't running).
"""

import imaplib
import json
import smtplib
import socket
import ssl
import subprocess
import sys
import unittest
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT_DIR = Path(__file__).resolve().parent.parent
USERS_FILE = ROOT_DIR / "docker" / "dovecot" / "config" / "users"


class TestDovecotSystemManager(unittest.TestCase):
    """Unit tests for system/python/dovecot_manager.py"""

    def setUp(self):
        self.script = ROOT_DIR / "system" / "python" / "dovecot_manager.py"
        self.assertTrue(self.script.exists(), f"Script must exist at {self.script}")
        self._original_users_content = (
            USERS_FILE.read_text(encoding="utf-8") if USERS_FILE.exists() else ""
        )

    def tearDown(self):
        USERS_FILE.write_text(self._original_users_content, encoding="utf-8")

    def run_manager(self, cmd: str, payload: dict) -> dict:
        proc = subprocess.run(
            [sys.executable, str(self.script), cmd],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(proc.returncode, 0, f"Script failed with code {proc.returncode}: {proc.stderr}")
        return json.loads(proc.stdout.strip())

    def test_01_sync_mailboxes_writes_passwd_file(self):
        """Synchronizes mailboxes and writes a valid Dovecot passwd-file line."""
        domain = "test-dovecot-mail.org"
        mailboxes = [
            {
                "address": f"user@{domain}",
                "passwordHash": "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2g",
                "quotaMb": 512,
            }
        ]

        res = self.run_manager("sync_mailboxes", {"domains": [domain], "mailboxes": mailboxes})

        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("syncedCount"), 1)
        self.assertIn(f"user@{domain}", res.get("mailboxes", []))

        content = USERS_FILE.read_text(encoding="utf-8")
        self.assertIn(f"user@{domain}:{{ARGON2ID}}$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2g:5000:5000", content)
        self.assertIn("userdb_quota_rule=*:storage=512M", content)

    def test_02_sync_preserves_other_domains(self):
        """Sync scoped to one domain must not remove passwd-file lines for other domains."""
        USERS_FILE.write_text(
            "keep@untouched-domain.org:{ARGON2ID}$argon2id$fixed:5000:5000::::userdb_quota_rule=*:storage=100M\n",
            encoding="utf-8",
        )

        domain = "test-dovecot-mail.org"
        res = self.run_manager(
            "sync_mailboxes",
            {
                "domains": [domain],
                "mailboxes": [
                    {"address": f"user2@{domain}", "passwordHash": "{ARGON2ID}$argon2id$other", "quotaMb": 256}
                ],
            },
        )

        self.assertTrue(res.get("success"))
        content = USERS_FILE.read_text(encoding="utf-8")
        self.assertIn("keep@untouched-domain.org", content, "Lines outside the sync scope must be preserved")
        self.assertIn(f"user2@{domain}", content)

    def test_03_sync_removes_deleted_mailboxes_in_scope(self):
        """Re-syncing a domain with an empty mailbox list removes its previous entries."""
        domain = "test-dovecot-mail.org"
        self.run_manager(
            "sync_mailboxes",
            {"domains": [domain], "mailboxes": [{"address": f"gone@{domain}", "passwordHash": "{ARGON2ID}$x", "quotaMb": 100}]},
        )
        res = self.run_manager("sync_mailboxes", {"domains": [domain], "mailboxes": []})

        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("syncedCount"), 0)
        content = USERS_FILE.read_text(encoding="utf-8")
        self.assertNotIn(f"gone@{domain}", content)

    def test_04_status_inspection(self):
        """Verifies system status probe returns the ImapStatusResponse schema fields."""
        res = self.run_manager("status", {"host": "127.0.0.1"})
        self.assertEqual(res.get("service"), "dovecot")
        self.assertIn("status", res)
        self.assertIn("port143Open", res)
        self.assertIn("port993Open", res)
        self.assertIn("tlsEnforced", res)
        self.assertIn("saslAuthConnected", res)
        self.assertIn("activeMailboxesCount", res)
        self.assertIn("lastChecked", res)


class TestDovecotConfigurations(unittest.TestCase):
    """Verifies that Dovecot config files and Postfix/Dovecot SASL wiring conform to spec."""

    def test_01_dovecot_conf_parameters(self):
        conf = ROOT_DIR / "docker" / "dovecot" / "dovecot.conf"
        self.assertTrue(conf.exists(), "dovecot.conf must exist")
        content = conf.read_text(encoding="utf-8")

        self.assertIn("mail_location = maildir:/var/mail/vhosts/%d/%n/Maildir", content)
        self.assertIn("CONTROL=/var/indexes/%d/%n", content)
        self.assertIn("mail_uid = 5000", content)
        self.assertIn("mail_gid = 5000", content)
        self.assertIn("scheme=ARGON2ID", content)
        self.assertIn("ssl = required", content)
        self.assertIn("port = 143", content)
        self.assertIn("port = 993", content)
        self.assertIn("port = 12345", content)
        self.assertIn("quota", content)

    def test_02_dockerfile_exists(self):
        dockerfile = ROOT_DIR / "docker" / "dovecot" / "Dockerfile"
        self.assertTrue(dockerfile.exists(), "Dockerfile must exist")
        content = dockerfile.read_text(encoding="utf-8")
        self.assertIn("dovecot", content)
        self.assertIn("EXPOSE 143 993", content)
        self.assertIn("sed -i 's/\\r$//' /usr/local/bin/entrypoint.sh", content)

    def test_03_entrypoint_seeds_dev_mailboxes(self):
        entrypoint = ROOT_DIR / "docker" / "dovecot" / "entrypoint.sh"
        self.assertTrue(entrypoint.exists(), "entrypoint.sh must exist")
        content = entrypoint.read_text(encoding="utf-8")
        self.assertIn("pw -s ARGON2ID", content)
        self.assertIn("vexlyx-dev", content)

    def test_04_postfix_sasl_integration(self):
        main_cf = ROOT_DIR / "docker" / "postfix" / "main.cf"
        content = main_cf.read_text(encoding="utf-8")
        self.assertIn("smtpd_sasl_type = dovecot", content)
        self.assertIn("smtpd_sasl_path = inet:dovecot:12345", content)
        self.assertIn("virtual_uid_maps = static:5000", content)
        self.assertIn("virtual_gid_maps = static:5000", content)

    def test_05_docker_compose_wiring(self):
        compose = ROOT_DIR / "docker-compose.yml"
        content = compose.read_text(encoding="utf-8")
        self.assertIn("dovecot:", content)
        self.assertIn("IMAP_PORT:-143", content)
        self.assertIn("IMAPS_PORT:-993", content)
        self.assertIn("./docker/mail-data/vhosts:/var/mail/vhosts", content)

    def test_06_host_setup_script_exists(self):
        setup_script = ROOT_DIR / "system" / "scripts" / "setup-dovecot.sh"
        self.assertTrue(setup_script.exists(), "setup-dovecot.sh must exist")
        content = setup_script.read_text(encoding="utf-8")
        self.assertIn("dovecot-imapd", content)
        self.assertIn("mail_uid = 5000", content)


class TestDovecotLiveImaps(unittest.TestCase):
    """Live IMAPS login test — skipped if the dev docker-compose stack isn't running."""

    def test_01_imaps_login_with_seeded_dev_mailbox(self):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

        try:
            conn = imaplib.IMAP4_SSL("127.0.0.1", 993, ssl_context=context, timeout=5)
        except (ConnectionRefusedError, OSError, TimeoutError):
            self.skipTest("Dovecot container is not reachable on 127.0.0.1:993 (dev stack not running)")
            return

        try:
            typ, _ = conn.login("test@vexlyx.local", "vexlyx-dev")
            self.assertEqual(typ, "OK")
            typ, data = conn.select("INBOX")
            self.assertEqual(typ, "OK")
        finally:
            conn.logout()

    def test_02_postfix_sasl_authenticates_against_dovecot(self):
        """Postfix submission (587) must authenticate against Dovecot's SASL backend (F4.1 + F4.2)."""
        try:
            smtp = smtplib.SMTP("127.0.0.1", 587, timeout=5)
        except (ConnectionRefusedError, OSError, socket.timeout):
            self.skipTest("Postfix container is not reachable on 127.0.0.1:587 (dev stack not running)")
            return

        try:
            smtp.ehlo()
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            smtp.starttls(context=context)
            smtp.ehlo()
            smtp.login("test@vexlyx.local", "vexlyx-dev")
        finally:
            smtp.quit()


if __name__ == "__main__":
    unittest.main(verbosity=2)
