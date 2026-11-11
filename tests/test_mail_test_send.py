"""
test_mail_test_send.py — Regression tests for the test-email helper (#194).

The API resolves the sender's domain ownership before calling the helper; these
tests cover the helper's own defences: a CRLF in a header must not append
headers or SMTP commands, and a body line that is a single dot must not end the
DATA section early.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "system" / "python"))

import postfix_manager  # noqa: E402


class FakeSocket:
    """Minimal socket stub that replays queued SMTP server responses."""

    def __init__(self, responses: list[bytes]):
        self.responses = list(responses)
        self.sent = b""
        self.closed = False

    def settimeout(self, _timeout):
        pass

    def recv(self, _size):
        return self.responses.pop(0) if self.responses else b""

    def sendall(self, data: bytes):
        self.sent += data

    def close(self):
        self.closed = True


SMTP_RESPONSES = [
    b"220 test ESMTP\r\n",
    b"250-test\r\n250-AUTH PLAIN\r\n250 OK\r\n",
    b"250 2.1.0 Ok\r\n",
    b"250 2.1.5 Ok\r\n",
    b"354 End data\r\n",
    b"250 2.0.0 Ok: queued\r\n",
]


def send(params: dict):
    fake = FakeSocket(SMTP_RESPONSES)
    with mock.patch.object(
        postfix_manager.socket, "create_connection", return_value=fake
    ):
        result = postfix_manager.send_test_email(params)
    return result, fake.sent


BASE = {
    "host": "127.0.0.1",
    "port": 587,
    "from": "no-reply@one.example",
    "to": "someone@example.net",
    "subject": "Diagnostics",
    "body": "Test body",
    "useTls": False,
}


class HeaderInjectionTest(unittest.TestCase):
    def test_rejects_line_breaks_in_subject(self):
        result, sent = send({**BASE, "subject": "Hello\r\nBcc: victim@example.net"})
        self.assertFalse(result["success"])
        self.assertIn("line breaks", result["error"])
        self.assertEqual(sent, b"")

    def test_rejects_line_breaks_in_addresses(self):
        for field in ("from", "to"):
            with self.subTest(field=field):
                result, sent = send(
                    {**BASE, field: "a@one.example>\r\nRCPT TO:<b@example.net"}
                )
                self.assertFalse(result["success"])
                self.assertIn("line breaks", result["error"])
                self.assertEqual(sent, b"")


class DotStuffingTest(unittest.TestCase):
    def test_body_line_with_dot_cannot_end_data(self):
        result, sent = send(
            {**BASE, "body": "Line one\r\n.\r\nMAIL FROM:<ceo@bank.example>"}
        )

        self.assertTrue(result["success"], result)
        self.assertIn(b"\r\n..\r\nMAIL FROM:<ceo@bank.example>", sent)
        # The only bare dot line is the DATA terminator.
        self.assertEqual(sent.count(b"\r\n.\r\n"), 1)
        self.assertTrue(sent.endswith(b"\r\n.\r\nQUIT\r\n"))

    def test_message_id_uses_the_sender_domain(self):
        result, sent = send(BASE)
        self.assertTrue(result["success"], result)
        self.assertIn(b"Message-ID: <", sent)
        self.assertIn(b"@one.example>", sent)


if __name__ == "__main__":
    unittest.main()
