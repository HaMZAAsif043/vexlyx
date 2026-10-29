"""Postfix 3.9 submission vs. mail-client setup probes (#158).

Postfix 3.9 defaults smtpd_forbid_unauth_pipelining to yes (an SMTP smuggling
mitigation): a client that sends commands before reading the previous reply is
answered `554 5.5.0 SMTP protocol synchronization` and disconnected. Thunderbird's
account probe sends EHLO and QUIT in one packet, so adding a mailbox failed. The
authenticated submission service (587) relaxes it; the MX-facing port 25 keeps
the default.

The live tests build docker/postfix, start a disposable container on random
loopback ports and talk to it with a raw socket. They are skipped when Docker is
not available.
"""

import re
import shutil
import socket
import subprocess
import time
import unittest
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
POSTFIX_DIR = REPO_ROOT / "docker" / "postfix"
IMAGE = "vexlyx-postfix-pipelining-test"


def service_block(master_cf: str, name: str) -> str:
    """Returns the master.cf entry for `name` including its -o continuation lines."""
    lines = master_cf.replace("\r\n", "\n").split("\n")
    start = next(i for i, line in enumerate(lines) if line.split() and line.split()[0] == name)
    block = [lines[start]]
    for line in lines[start + 1:]:
        if line.startswith((" ", "\t")):
            block.append(line)
        else:
            break
    return "\n".join(block)


class MasterCfTest(unittest.TestCase):
    def setUp(self):
        self.master_cf = (POSTFIX_DIR / "master.cf").read_text(encoding="utf-8")
        self.main_cf = (POSTFIX_DIR / "main.cf").read_text(encoding="utf-8")

    def test_submission_allows_pipelined_commands(self):
        self.assertIn("-o smtpd_forbid_unauth_pipelining=no", service_block(self.master_cf, "submission"))

    def test_the_mx_facing_port_stays_strict(self):
        self.assertNotIn("smtpd_forbid_unauth_pipelining", service_block(self.master_cf, "smtp"))

    def test_nothing_relaxes_it_globally(self):
        self.assertNotRegex(self.main_cf, r"smtpd_forbid_unauth_pipelining\s*=\s*no")

    def test_submission_still_requires_tls_and_authentication(self):
        block = service_block(self.master_cf, "submission")
        self.assertIn("smtpd_tls_security_level=encrypt", block)
        self.assertIn("smtpd_sasl_auth_enable=yes", block)
        self.assertIn("smtpd_client_restrictions=permit_sasl_authenticated,permit_mynetworks,reject", block)


def docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


def probe(port: int, payload: bytes = b"EHLO probe.example\r\nQUIT\r\n", timeout: float = 8.0) -> str:
    """Connects, waits for the banner, sends `payload` in ONE packet, returns all replies."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        banner = sock.recv(4096)
        sock.sendall(payload)
        received = banner
        try:
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                received += chunk
        except socket.timeout:
            pass
    return received.decode("utf-8", errors="replace")


@unittest.skipUnless(docker_available(), "Docker is required")
class LivePipeliningProbeTest(unittest.TestCase):
    container = ""
    smtp_port = 0
    submission_port = 0

    @classmethod
    def setUpClass(cls):
        build = subprocess.run(
            ["docker", "build", "-q", "-t", IMAGE, str(POSTFIX_DIR)], capture_output=True, text=True
        )
        if build.returncode != 0:
            raise unittest.SkipTest(f"could not build the Postfix image: {build.stderr[-300:]}")

        cls.container = f"vexlyx-pipelining-{uuid.uuid4().hex[:8]}"
        run = subprocess.run(
            [
                "docker", "run", "-d", "--rm", "--name", cls.container,
                "-p", "127.0.0.1::25", "-p", "127.0.0.1::587",
                "-e", "MYHOSTNAME=mail.probe.test", "-e", "MYDOMAIN=probe.test",
                # main.cf authenticates against Dovecot at dovecot:12345; without
                # something answering there smtpd dies before sending a banner.
                "--add-host", "dovecot:127.0.0.1",
                IMAGE,
            ],
            capture_output=True,
            text=True,
        )
        if run.returncode != 0:
            raise unittest.SkipTest(f"could not start the container: {run.stderr[-300:]}")
        cls.addClassCleanup(lambda: subprocess.run(["docker", "rm", "-f", cls.container], capture_output=True))
        cls._start_fake_dovecot_auth()

        cls.smtp_port = cls._published_port("25/tcp")
        cls.submission_port = cls._published_port("587/tcp")
        cls._wait_for_banner(cls.smtp_port)
        cls._wait_for_banner(cls.submission_port)

    @classmethod
    def _start_fake_dovecot_auth(cls) -> None:
        """Answers Dovecot's auth handshake (it only has to advertise PLAIN)."""
        handshake = r"VERSION\t1\t2\nMECH\tPLAIN\tplaintext\nSPID\t1\nCUID\t1\nCOOKIE\t00\nDONE\n"
        loop = f"while true; do printf '{handshake}' | nc -l -p 12345 >/dev/null 2>&1; done"
        subprocess.run(["docker", "exec", "-d", cls.container, "sh", "-c", loop], check=True, capture_output=True)

    @classmethod
    def _published_port(cls, internal: str) -> int:
        out = subprocess.run(["docker", "port", cls.container, internal], capture_output=True, text=True).stdout
        return int(re.search(r":(\d+)\s*$", out.strip().splitlines()[0]).group(1))

    @classmethod
    def _wait_for_banner(cls, port: int) -> None:
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=3) as sock:
                    sock.settimeout(3)
                    if sock.recv(256).startswith(b"220"):
                        return
            except OSError:
                pass
            time.sleep(1)
        logs = subprocess.run(["docker", "logs", "--tail", "30", cls.container], capture_output=True, text=True)
        raise AssertionError(f"port {port} never produced a 220 banner:\n{logs.stdout}{logs.stderr}")

    def test_submission_answers_a_pipelined_ehlo_and_quit(self):
        reply = probe(self.submission_port)
        self.assertIn("250", reply)
        self.assertIn("221", reply)
        self.assertNotIn("554", reply)

    def test_the_mx_port_still_rejects_pipelining_before_the_banner_is_read(self):
        reply = probe(self.smtp_port)
        self.assertIn("554 5.5.0", reply)
        self.assertNotIn("221", reply)

    def test_submission_still_demands_tls_before_authentication(self):
        reply = probe(self.submission_port, b"EHLO probe.example\r\n")
        self.assertIn("STARTTLS", reply)
        self.assertNotRegex(reply, r"250[- ]AUTH")


if __name__ == "__main__":
    unittest.main()
