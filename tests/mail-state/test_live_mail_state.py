import copy
import imaplib
import json
import os
from pathlib import Path
import smtplib
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "system/python"))
import mail_state as state
import mail_state_migrate as migration


@unittest.skipUnless(os.environ.get("VEXLYX_TEST_STATE_VOLUME"), "Run with the isolated mail-state Linux runner")
class LiveMailStateTests(unittest.TestCase):
    @classmethod
    def docker(cls, *arguments, check=True):
        result = subprocess.run(["docker", *arguments], text=True, capture_output=True, timeout=60)
        if check and result.returncode:
            raise RuntimeError(result.stderr[-2000:])
        return result

    @classmethod
    def start(cls, component, prefix="", suffix="", seed=False):
        name = cls.names[component] + suffix
        mount = f"type=volume,source={cls.volume},target=/var/lib/vexlyx-mail/{component},volume-subpath={prefix}{component}"
        command = ["run", "-d", "--name", name, "--network", cls.network, "--network-alias", component + suffix,
                   "-e", f"VEXLYX_SEED_DEV_FIXTURES={str(seed).lower()}", "--mount", mount,
                   "--mount", f"type=volume,source={cls.volume},target=/var/mail/vhosts,volume-subpath=vhosts"]
        if component == "postfix":
            command += ["--mount", f"type=volume,source={cls.volume},target=/etc/opendkim,volume-subpath=opendkim"]
        command += [f"vexlyx-{component}:issue36-test"]
        cls.docker(*command)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = cls.docker("exec", name, "/usr/local/bin/mail-state.sh", "health", check=False)
            if result.returncode == 0:
                return name
            time.sleep(0.25)
        raise RuntimeError(component + " failed readiness: " + cls.docker("logs", name, check=False).stderr[-2000:])

    @classmethod
    def setUpClass(cls):
        cls.volume = os.environ["VEXLYX_TEST_STATE_VOLUME"]
        if not cls.volume.startswith("vexlyx-issue36-"):
            raise RuntimeError("Tests require a disposable vexlyx-issue36-* volume")
        cls.network = "vexlyx-issue36-" + uuid.uuid4().hex[:12]
        cls.names = {component: cls.network + "-" + component for component in ("postfix", "dovecot")}
        cls.root = Path("/state")
        os.environ["VEXLYX_MAIL_STATE_DIR"] = str(cls.root)
        for component, name in cls.names.items(): os.environ[f"VEXLYX_{component.upper()}_CONTAINER"] = name
        cls.password = "fixture-old-password"
        cls.new_password = "fixture-new-password"
        cls.old_hash = cls.docker("run", "--rm", "--entrypoint", "doveadm", "vexlyx-dovecot:issue36-test", "-c", "/dev/null", "pw", "-s", "ARGON2ID", "-p", cls.password).stdout.strip()
        cls.new_hash = cls.docker("run", "--rm", "--entrypoint", "doveadm", "vexlyx-dovecot:issue36-test", "-c", "/dev/null", "pw", "-s", "ARGON2ID", "-p", cls.new_password).stdout.strip()
        cls.data = {"domains": ["one.example", "two.example"], "mailboxes": [
            {"address": "admin@one.example", "passwordHash": cls.old_hash, "quotaMb": 1024},
            {"address": "keep@two.example", "passwordHash": cls.old_hash, "quotaMb": 1024},
        ], "aliases": [{"source": "help@one.example", "destinations": ["admin@one.example"]}]}
        cls.source = tempfile.TemporaryDirectory(prefix="legacy-mail-")
        source = Path(cls.source.name)
        for name, content in state.postfix_files(cls.data["domains"], [mailbox["address"] for mailbox in cls.data["mailboxes"]], cls.data["aliases"]).items():
            path = source / "docker/postfix/config" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        users = source / "docker/dovecot/config/users"
        users.parent.mkdir(parents=True)
        users.write_text(state.passwd_lines(cls.data["mailboxes"]))
        migration.migrate(source, cls.root)
        (cls.root / "vhosts").mkdir(exist_ok=True)
        legacy_message = cls.root / "vhosts/one.example/admin/Maildir/new/legacy-message"
        for subdirectory in ("cur", "new", "tmp"):
            (legacy_message.parent.parent / subdirectory).mkdir(parents=True, exist_ok=True)
        legacy_message.write_text("Subject: legacy\n\npreserved legacy message\n")
        cls.docker("network", "create", cls.network)
        cls.addClassCleanup(cls.teardown)
        cls.docker("network", "connect", cls.network, os.environ["HOSTNAME"])
        cls.start("dovecot")
        cls.start("postfix")
        network_info = json.loads(cls.docker("inspect", cls.names["postfix"]).stdout)[0]["NetworkSettings"]["Networks"]
        cls.smtp_host = network_info[cls.network]["IPAddress"]
        cls.imap_host = json.loads(cls.docker("inspect", cls.names["dovecot"]).stdout)[0]["NetworkSettings"]["Networks"][cls.network]["IPAddress"]
        cls.docker("exec", cls.names["postfix"], "postconf", "-e", "mynetworks=127.0.0.0/8")
        cls.docker("exec", cls.names["postfix"], "postfix", "reload")

    @classmethod
    def teardown(cls):
        for name in cls.names.values(): cls.docker("rm", "-f", name, check=False)
        cls.docker("network", "disconnect", cls.network, os.environ["HOSTNAME"], check=False)
        cls.docker("network", "rm", cls.network, check=False)
        cls.source.cleanup()

    def setUp(self):
        with state.state_lock(): state.reconcile(copy.deepcopy(self.data))

    def auth(self, address, password):
        return self.docker("exec", self.names["dovecot"], "doveadm", "auth", "test", address, password, check=False).returncode

    def lookup(self, name, key):
        generation = state.active_generation("postfix")
        return self.docker("exec", self.names["postfix"], "postmap", "-q", key,
                           f"lmdb:/var/lib/vexlyx-mail/postfix/generations/{generation}/{name}", check=False).stdout.strip()

    def rcpt(self, address):
        with smtplib.SMTP(self.smtp_host, 25, timeout=10) as client:
            client.ehlo("external.example")
            client.mail("sender@external.example")
            return client.rcpt(address)[0]

    def test_migrated_users_authenticate_and_messages_survive(self):
        self.assertEqual(self.auth("admin@one.example", self.password), 0)
        self.assertEqual(self.auth("keep@two.example", self.password), 0)
        self.assertEqual(self.lookup("virtual_mailbox_maps", "admin@one.example"), "one.example/admin/Maildir/")
        self.assertIn("preserved legacy message", (self.root / "vhosts/one.example/admin/Maildir/new/legacy-message").read_text())

    def test_password_reset_changes_auth_without_container_recreation(self):
        before = self.docker("inspect", "--format", "{{.Id}}", self.names["dovecot"]).stdout
        changed = copy.deepcopy(self.data)
        changed["mailboxes"][0]["passwordHash"] = self.new_hash
        with state.state_lock(): state.reconcile(changed)
        self.assertNotEqual(self.auth("admin@one.example", self.password), 0)
        self.assertEqual(self.auth("admin@one.example", self.new_password), 0)
        self.assertEqual(before, self.docker("inspect", "--format", "{{.Id}}", self.names["dovecot"]).stdout)
        self.assertEqual(self.auth("keep@two.example", self.password), 0)
        context = ssl._create_unverified_context()  # Disposable containers use fixture certificates.
        with imaplib.IMAP4_SSL(self.imap_host, 993, ssl_context=context, timeout=10) as client:
            with self.assertRaises(imaplib.IMAP4.error): client.login("admin@one.example", self.password)
            self.assertEqual(client.login("admin@one.example", self.new_password)[0], "OK")
        with smtplib.SMTP(self.smtp_host, 587, timeout=10) as client:
            client.starttls(context=context)
            with self.assertRaises(smtplib.SMTPAuthenticationError): client.login("admin@one.example", self.password)
            self.assertEqual(client.login("admin@one.example", self.new_password)[0], 235)

    def test_smtp_delivery_reaches_existing_maildir_after_sync(self):
        message = "Subject: issue36-delivery\r\n\r\nmail-state delivery fixture\r\n"
        with smtplib.SMTP(self.smtp_host, 25, timeout=10) as client:
            self.assertEqual(client.sendmail("sender@external.example", ["admin@one.example"], message), {})
        directory = self.root / "vhosts/one.example/admin/Maildir"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if any(b"issue36-delivery" in path.read_bytes() for subdirectory in ("new", "cur") for path in (directory / subdirectory).iterdir()):
                return
            time.sleep(0.1)
        self.fail("SMTP accepted the recipient but LMTP did not deliver the message")

    def test_mailbox_add_and_delete_change_smtp_acceptance(self):
        self.assertEqual(self.rcpt("new@one.example"), 550)
        changed = copy.deepcopy(self.data)
        changed["mailboxes"].append({"address": "new@one.example", "passwordHash": self.new_hash, "quotaMb": 1024})
        with state.state_lock(): state.reconcile(changed)
        self.assertEqual(self.rcpt("new@one.example"), 250)
        self.assertEqual(self.auth("new@one.example", self.new_password), 0)
        with state.state_lock(): state.reconcile(copy.deepcopy(self.data))
        self.assertEqual(self.rcpt("new@one.example"), 550)

    def test_alias_changes_are_immediately_queryable(self):
        self.assertEqual(self.lookup("virtual_alias_maps", "help@one.example"), "admin@one.example")
        changed = copy.deepcopy(self.data)
        changed["aliases"][0]["destinations"] = ["keep@two.example"]
        with state.state_lock(): state.reconcile(changed)
        self.assertEqual(self.lookup("virtual_alias_maps", "help@one.example"), "keep@two.example")

    def test_directory_mount_sees_atomic_file_replacement(self):
        for component in ("postfix", "dovecot"):
            path = self.root / component / "visibility-probe"
            state.atomic_write(path, "before", 0o644)
            location = f"/var/lib/vexlyx-mail/{component}/visibility-probe"
            self.assertEqual(self.docker("exec", self.names[component], "cat", location).stdout, "before")
            state.atomic_write(path, "after", 0o644)
            self.assertEqual(self.docker("exec", self.names[component], "cat", location).stdout, "after")

    def test_fresh_development_state_is_writable_by_non_root_api(self):
        root = self.root / "unprivileged"
        root.mkdir()
        backup = root / "dovecot/generations" / ("b" * 32) / "users.before-remediation.fixture"
        backup.parent.mkdir(parents=True)
        backup.write_text("private backup fixture\n")
        backup.chmod(0o600)
        writer = 20001
        suffix = "-unprivileged"
        initializer = self.network + "-init"
        parent_mode = self.root.stat().st_mode & 0o777
        self.root.chmod(parent_mode | 0o001)
        try:
            self.docker("create", "--name", initializer, "--entrypoint", "sh",
                        "--mount", f"type=volume,source={self.volume},target=/state,volume-subpath=unprivileged",
                        "alpine:3.20", "-c",
                        f"mkdir /source && chown {writer}:{writer} /source && sed 's/\\r$//' /init.sh | sh")
            self.docker("cp", str(Path(__file__).resolve().parents[2] / "docker/mail-state-init.sh"), initializer + ":/init.sh")
            self.docker("start", "--attach", initializer)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            for component in ("dovecot", "postfix"):
                self.start(component, prefix="unprivileged/", suffix=suffix)
                self.assertEqual((root / component / "generations").stat().st_uid, writer)
            environment = {**os.environ, "HOME": str(root), "VEXLYX_MAIL_STATE_DIR": str(root),
                           "VEXLYX_DOVECOT_CONTAINER": self.names["dovecot"] + suffix,
                           "VEXLYX_POSTFIX_CONTAINER": self.names["postfix"] + suffix}
            docker_group = os.stat("/var/run/docker.sock").st_gid
            def as_writer():
                os.setgroups([docker_group])
                os.setgid(writer)
                os.setuid(writer)
            code = """import json,sys
from mail_state import MailStateError,state_lock,reconcile
try:
    with state_lock():
        for _ in range(3): reconcile(json.loads(sys.argv[1]))
except MailStateError as error:
    print(json.dumps({"code": error.code, "details": error.details}), file=sys.stderr)
    raise
"""
            result = subprocess.run([sys.executable, "-c", code, json.dumps(self.data)],
                                    cwd=Path(state.__file__).parent, env=environment,
                                    capture_output=True, text=True, timeout=120, preexec_fn=as_writer)
            self.assertEqual(result.returncode, 0, result.stderr)
            generation = (root / "dovecot/active.conf").read_text().splitlines()[0].split(":")[1]
            users = root / "dovecot/generations" / generation / "users"
            self.assertEqual(users.stat().st_uid, writer)
            self.assertEqual(users.stat().st_mode & 0o777, 0o640)
            self.assertEqual(len(list((root / "dovecot/generations").iterdir())), 2)
            def as_outsider():
                os.setgroups([])
                os.setgid(writer + 1)
                os.setuid(writer + 1)
            denied = subprocess.run([sys.executable, "-c", "import sys; open(sys.argv[1]).read()", str(users)],
                                    capture_output=True, text=True, preexec_fn=as_outsider)
            self.assertNotEqual(denied.returncode, 0)
            self.assertEqual(self.docker("exec", self.names["dovecot"] + suffix, "doveadm", "auth", "test",
                                         "admin@one.example", self.password, check=False).returncode, 0)
        finally:
            for component in ("dovecot", "postfix"):
                self.docker("rm", "-f", self.names[component] + suffix, check=False)
            self.docker("rm", "-f", initializer, check=False)
            self.root.chmod(parent_mode)

    def test_fresh_development_state_initializes_before_dovecot_reads_config(self):
        (self.root / "fresh/dovecot").mkdir(parents=True)
        name = self.names["dovecot"] + "-fresh"
        try:
            self.start("dovecot", prefix="fresh/", suffix="-fresh", seed=True)
            self.assertEqual(self.docker("exec", name, "doveadm", "auth", "test", "admin@vexlyx.local", "vexlyx-dev", check=False).returncode, 0)
        finally:
            self.docker("rm", "-f", name, check=False)

    def test_missing_unreadable_or_stale_lmdb_is_unhealthy(self):
        path = state.active_directory("postfix") / "virtual_mailbox_maps.lmdb"
        data = path.read_bytes()
        path.unlink()
        self.assertNotEqual(self.docker("exec", self.names["postfix"], "/usr/local/bin/mail-state.sh", "health", check=False).returncode, 0)
        state.atomic_write(path, data, 0o644)
        path.chmod(0)
        self.assertNotEqual(self.docker("exec", self.names["postfix"], "/usr/local/bin/mail-state.sh", "health", check=False).returncode, 0)
        path.chmod(0o644)
        source = path.with_suffix("")
        original = source.read_bytes()
        source.write_bytes(original + b"unexpected@one.example one.example/unexpected/Maildir/\n")
        self.assertNotEqual(self.docker("exec", self.names["postfix"], "/usr/local/bin/mail-state.sh", "health", check=False).returncode, 0)
        source.write_bytes(original)
        state.run_service("postfix", "health")

    def test_forced_compilation_failure_retains_active_state(self):
        before = (self.root / "postfix/active.conf").read_bytes()
        container = self.names["postfix"]
        self.docker("exec", container, "mv", "/usr/sbin/postmap", "/usr/sbin/postmap.disabled")
        try:
            with state.state_lock(), self.assertRaises(state.MailStateError): state.reconcile(copy.deepcopy(self.data))
            self.assertEqual((self.root / "postfix/active.conf").read_bytes(), before)
        finally:
            self.docker("exec", container, "mv", "/usr/sbin/postmap.disabled", "/usr/sbin/postmap")
        state.run_service("postfix", "health")

    def test_recreation_keeps_authentication_and_recipient_maps(self):
        for component in ("postfix", "dovecot"):
            self.docker("rm", "-f", self.names[component])
            self.start(component)
        self.__class__.smtp_host = json.loads(self.docker("inspect", self.names["postfix"]).stdout)[0]["NetworkSettings"]["Networks"][self.network]["IPAddress"]
        self.assertEqual(self.auth("admin@one.example", self.password), 0)
        self.assertEqual(self.lookup("virtual_mailbox_maps", "admin@one.example"), "one.example/admin/Maildir/")
        self.assertIn("preserved legacy message", (self.root / "vhosts/one.example/admin/Maildir/new/legacy-message").read_text())


if __name__ == "__main__": unittest.main(verbosity=2)
