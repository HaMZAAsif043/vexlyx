"""Real SMTP AUTH, IMAPS, and local delivery after fixture remediation.

For browser testing: python -m tests.test_mail_credential_protocols --keep
Then clean up using --cleanup (reads the ignored browser-state file).
"""

import imaplib
import json
import smtplib
import ssl
import time
import unittest
import uuid
from pathlib import Path

from tests.test_mail_credential_security import GUARD, IMAGE, PUBLISHED, USERS, STATE_ROOT, initialize_state, docker, row


ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "docker/mail-data/credential-browser-test.json"
ADDRESS = "customer@credential-test.example"
PASSWORD = "private-test-password"


class MailStack:
    def __init__(self):
        self.prefix = "vexlyx-credential-protocol-" + uuid.uuid4().hex[:10]
        self.names = {service: self.prefix + "-" + service for service in ("offline", "dovecot", "postfix", "roundcube")}
        self.volume = self.prefix + "-users"
        self.network = self.prefix + "-network"

    def close(self):
        for name in reversed(list(self.names.values())):
            docker("rm", "-f", name, check=False)
        docker("volume", "rm", self.volume, check=False)
        docker("network", "rm", self.network, check=False)

    def start(self, webmail=False):
        docker("network", "create", self.network)
        docker("volume", "create", self.volume)
        mount = f"type=volume,src={self.volume},dst={STATE_ROOT}"
        docker("run", "-d", "--name", self.names["offline"], "--mount", mount,
               "--entrypoint", "sh", IMAGE, "-c", "sleep 3600")
        initialize_state(self.names["offline"])
        good = docker("exec", self.names["offline"], "doveadm", "-c", "/dev/null", "pw",
                      "-s", "ARGON2ID", "-p", PASSWORD).stdout.strip()
        docker("exec", "-i", self.names["offline"], "sh", "-c", f"cat > {USERS}",
               input=row("test@vexlyx.local", PUBLISHED) + row("admin@vexlyx.local", PUBLISHED) + row(ADDRESS, good))
        docker("exec", self.names["offline"], GUARD, "remediate")
        docker("run", "-d", "--name", self.names["dovecot"], "--network", self.network,
               "--network-alias", "dovecot", "--mount", mount, "-p", "127.0.0.1::993",
               "-e", "VEXLYX_SEED_DEV_FIXTURES=false", IMAGE)
        docker("run", "-d", "--name", self.names["postfix"], "--network", self.network,
               "--network-alias", "postfix", "-p", "127.0.0.1::587",
               "-e", "VEXLYX_SEED_DEV_FIXTURES=false", "vexlyx-postfix:credentials-test")
        self.imap_port = self.port("dovecot", "993/tcp")
        self.smtp_port = self.port("postfix", "587/tcp")
        self.wait_for_imap()
        self.wait_for_smtp()
        # Test-only local routing. No public recipients or external mail traffic.
        state = "/var/lib/vexlyx-mail/postfix"
        generation = docker("exec", self.names["postfix"], "sed", "-n",
                            "1s/^# generation://p", f"{state}/active.conf").stdout.strip()
        directory = f"{state}/generations/{generation}"
        docker("exec", "-i", self.names["postfix"], "sh", "-c",
               f"cat > {directory}/virtual_domains", input="credential-test.example\n")
        docker("exec", "-i", self.names["postfix"], "sh", "-c",
               f"cat > {directory}/virtual_mailbox_maps",
               input=f"{ADDRESS} credential-test.example/customer/Maildir/\n")
        docker("exec", self.names["postfix"], "/usr/local/bin/mail-state.sh", "prepare", generation)
        docker("exec", self.names["postfix"], "postfix", "reload")
        if webmail:
            docker("create", "--name", self.names["roundcube"], "--network", self.network,
                   "-p", "127.0.0.1::80", "-e", "ROUNDCUBEMAIL_DB_TYPE=sqlite",
                   "-e", "ROUNDCUBEMAIL_DEFAULT_HOST=tls://dovecot",
                   "-e", "ROUNDCUBEMAIL_DEFAULT_PORT=143",
                   "-e", "ROUNDCUBEMAIL_SMTP_SERVER=tls://postfix",
                   "-e", "ROUNDCUBEMAIL_SMTP_PORT=587", "roundcube/roundcubemail:1.6.18-apache")
            docker("cp", str(ROOT / "docker/roundcube/config/local.inc.php"),
                   self.names["roundcube"] + ":/var/roundcube/config/local.inc.php")
            docker("start", self.names["roundcube"])
            self.webmail_url = f"http://127.0.0.1:{self.port('roundcube', '80/tcp')}"

    def port(self, service, key):
        state = json.loads(docker("inspect", self.names[service]).stdout)[0]
        return int(state["NetworkSettings"]["Ports"][key][0]["HostPort"])

    def imap(self):
        return imaplib.IMAP4_SSL("127.0.0.1", self.imap_port,
                                ssl_context=ssl._create_unverified_context(), timeout=15)

    def smtp(self):
        client = smtplib.SMTP("127.0.0.1", self.smtp_port, timeout=15)
        client.ehlo()
        client.starttls(context=ssl._create_unverified_context())
        client.ehlo()
        return client

    def wait_for_imap(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                with self.imap():
                    return
            except (OSError, imaplib.IMAP4.abort):
                time.sleep(0.2)
        raise AssertionError("Isolated IMAPS server did not start")

    def wait_for_smtp(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                with self.smtp():
                    return
            except (OSError, smtplib.SMTPException):
                time.sleep(0.2)
        raise AssertionError("Isolated SMTP server did not start")


class TestMailCredentialProtocols(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = MailStack()
        cls.addClassCleanup(cls.stack.close)
        cls.stack.start()

    def test_smtp_rejects_both_exposed_accounts_and_accepts_real_mailbox(self):
        for address in ("test@vexlyx.local", "admin@vexlyx.local"):
            with self.subTest(address=address), self.stack.smtp() as client:
                with self.assertRaises(smtplib.SMTPAuthenticationError) as failure:
                    client.login(address, "vexlyx-dev")
                self.assertEqual(failure.exception.smtp_code, 535)
        with self.stack.smtp() as client:
            self.assertEqual(client.login(ADDRESS, PASSWORD)[0], 235)

    def test_imap_rejects_exposed_accounts_after_upgrade(self):
        for address in ("test@vexlyx.local", "admin@vexlyx.local"):
            with self.subTest(address=address), self.stack.imap() as client:
                with self.assertRaises(imaplib.IMAP4.error):
                    client.login(address, "vexlyx-dev")

    def test_legitimate_mailbox_sends_and_receives_after_upgrade(self):
        marker = "credential-security-" + uuid.uuid4().hex
        with self.stack.smtp() as client:
            client.login(ADDRESS, PASSWORD)
            client.sendmail(ADDRESS, [ADDRESS], f"From: {ADDRESS}\r\nTo: {ADDRESS}\r\nSubject: {marker}\r\n\r\nLocal delivery verification.\r\n")
        with self.stack.imap() as client:
            self.assertEqual(client.login(ADDRESS, PASSWORD)[0], "OK")
            for _ in range(30):
                client.select("INBOX")
                status, messages = client.search(None, "SUBJECT", marker)
                if status == "OK" and messages[0]:
                    return
                time.sleep(0.5)
        self.fail("Authenticated local message was not delivered to the legitimate mailbox")


if __name__ == "__main__":
    import sys
    if "--keep" in sys.argv:
        if STATE.exists():
            raise SystemExit("Clean up the previous isolated browser stack with --cleanup first.")
        stack = MailStack()
        try:
            stack.start(webmail=True)
            STATE.parent.mkdir(parents=True, exist_ok=True)
            STATE.write_text(json.dumps(vars(stack)), encoding="utf-8")
            print(stack.webmail_url)
            print(f"Test mailbox: {ADDRESS}; test password: {PASSWORD}")
        except BaseException:
            stack.close()
            raise
    elif "--cleanup" in sys.argv:
        stack = MailStack()
        stack.__dict__.update(json.loads(STATE.read_text(encoding="utf-8")))
        # Only names from this test harness may be removed.
        if not stack.prefix.startswith("vexlyx-credential-protocol-") or any(
            not value.startswith(stack.prefix) for value in [*stack.names.values(), stack.volume, stack.network]
        ):
            raise SystemExit("Invalid browser test resource names")
        stack.close()
        STATE.unlink()
    else:
        unittest.main(verbosity=2)
