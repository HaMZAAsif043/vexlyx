import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("bash") and shutil.which("git") and os.name != "nt", "Requires the Linux installer environment")
class MailUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vexlyx-upgrade-")
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "checkout"
        self.root = Path(self.temp.name) / "state"
        self.source.mkdir()
        self.git("init", "-b", "legacy")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Upgrade fixture")
        self.legacy = self.source / "docker/dovecot/config/users"
        self.legacy.parent.mkdir(parents=True)
        self.legacy.write_text("tracked fixture\n")
        self.maps = {
            "docker/postfix/config/virtual_domains": b"one.example\n",
            "docker/postfix/config/virtual_mailbox_maps": b"real@one.example one.example/real/Maildir/\n",
            "docker/postfix/config/virtual_alias_maps": b"help@one.example real@one.example\n",
            "docker/postfix/opendkim/KeyTable": b"default._domainkey.one.example one.example:default:/etc/opendkim/keys/one.example/default.private\n",
            "docker/postfix/opendkim/SigningTable": b"*@one.example default._domainkey.one.example\n",
            "docker/postfix/opendkim/TrustedHosts": b"127.0.0.1\nlocalhost\n",
        }
        for name in self.maps:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("tracked fixture\n")
        (self.source / "source.txt").write_text("source\n")
        self.git("add", ".")
        self.git("commit", "-m", "legacy")
        self.git("checkout", "-b", "upgrade")
        self.git("rm", "docker/dovecot/config/users")
        self.git("rm", *self.maps)
        target = self.source / "system/python/mail_state_migrate.py"
        target.parent.mkdir(parents=True)
        target.write_bytes((Path(__file__).parent / "mail_state_migrate.py").read_bytes())
        self.git("add", ".")
        self.git("commit", "-m", "persistent state")
        self.git("checkout", "legacy")
        self.git("fetch", ".", "upgrade")
        self.runtime = b"real@one.example:{ARGON2ID}$fixture:5000:5000::::\n"
        self.legacy.write_bytes(self.runtime)
        for name, content in self.maps.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        bootstrap = (Path(__file__).resolve().parents[2] / "install.sh").read_text()
        self.function = bootstrap.split("prepare_mail_upgrade() {", 1)[1].split('\nensure_git() {', 1)[0]
        self.environment = {**os.environ, "VEXLYX_HOME": str(self.source), "VEXLYX_MAIL_STATE_DIR": str(self.root)}

    def git(self, *arguments):
        return subprocess.run(["git", *arguments], cwd=self.source, check=True, capture_output=True, text=True)

    def upgrade(self):
        return subprocess.run(["bash", "-c", "set -euo pipefail\nprepare_mail_upgrade() {" + self.function + "\nprepare_mail_upgrade"],
                              cwd=self.source, env=self.environment, capture_output=True, text=True, timeout=30)

    def test_dirty_runtime_is_backed_up_before_git_deletes_tracked_files(self):
        result = self.upgrade()
        self.assertEqual(result.returncode, 0, result.stderr)
        marker = json.loads((self.root / ".migration.json").read_text())
        backup = Path(marker["backup"]) / "docker/dovecot/config/users"
        self.assertEqual(backup.read_bytes(), self.runtime)
        self.git("merge", "--ff-only", "FETCH_HEAD")
        self.assertFalse(self.legacy.exists())
        users = list((self.root / "dovecot/generations").glob("*/users"))
        self.assertEqual(users[0].read_bytes(), self.runtime)
        self.assertEqual(self.git("status", "--porcelain").stdout, "")
        for name, content in self.maps.items():
            self.assertEqual((Path(marker["backup"]) / name).read_bytes(), content)
            self.assertFalse((self.source / name).exists())

    def test_documented_manual_upgrade_preserves_all_runtime_maps(self):
        self.git("remote", "add", "origin", ".")
        self.git("branch", "main", "upgrade")
        commands = Path(self.temp.name) / "bin"
        commands.mkdir()
        for name, body in {"docker": "exit 0", "sudo": 'exec "$@"'}.items():
            script = commands / name
            script.write_text("#!/bin/sh\n" + body + "\n")
            script.chmod(0o755)
        document = (Path(__file__).resolve().parents[2] / "docs/dev/email/mail-credential-remediation.md").read_text()
        section = document.split("## Before upgrading an existing deployment", 1)[1].split("## Remediate and restart", 1)[0]
        blocks = re.findall(r"```sh\n(.*?)```", section, re.S)
        recipe = "\n".join(blocks).replace("MAIL_STATE_DIR=/var/lib/vexlyx/mail", f'MAIL_STATE_DIR="{self.root}"')
        environment = {**self.environment, "PATH": str(commands) + os.pathsep + os.environ["PATH"]}
        result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + recipe], cwd=self.source,
                                env=environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        marker = json.loads((self.root / ".migration.json").read_text())
        for name, content in {**self.maps, "docker/dovecot/config/users": self.runtime}.items():
            self.assertEqual((Path(marker["backup"]) / name).read_bytes(), content)
            self.assertFalse((self.source / name).exists())
        for name in ("virtual_domains", "virtual_mailbox_maps", "virtual_alias_maps"):
            path = next((self.root / "postfix/generations").glob("*/" + name))
            self.assertEqual(path.read_bytes(), self.maps["docker/postfix/config/" + name])
        for name in ("KeyTable", "SigningTable", "TrustedHosts"):
            self.assertEqual((self.root / "opendkim" / name).read_bytes(), self.maps["docker/postfix/opendkim/" + name])

    def test_unrelated_source_changes_stop_before_migration_or_reset(self):
        (self.source / "source.txt").write_text("local edits\n")
        result = self.upgrade()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Source changes detected", result.stderr)
        self.assertEqual(self.legacy.read_bytes(), self.runtime)
        self.assertEqual((self.source / "source.txt").read_text(), "local edits\n")
        self.assertFalse(self.root.exists())

    def test_staged_changes_are_never_reset(self):
        self.git("add", "docker/dovecot/config/users")
        result = self.upgrade()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Staged source changes", result.stderr)
        self.assertEqual(self.legacy.read_bytes(), self.runtime)
        self.assertFalse(self.root.exists())


if __name__ == "__main__": unittest.main()
