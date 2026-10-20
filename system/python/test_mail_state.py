import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
import mail_state as state
import mail_state_migrate as migration


def snapshot():
    return {"domains": ["one.example", "two.example"], "mailboxes": [
        {"address": "admin@one.example", "passwordHash": "$argon2id$v=19$m=65536,p=1,t=3$salt$digest", "quotaMb": 512},
        {"address": "keep@two.example", "passwordHash": "{ARGON2ID}$argon2id$other", "quotaMb": 1024},
    ], "aliases": [{"source": "help@one.example", "destinations": ["admin@one.example"]}]}


class MailStateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vexlyx-mail-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name) / "source"
        self.root = Path(self.temporary.name) / "state"
        self.source.mkdir()
        self.environment = patch.dict(os.environ, {"VEXLYX_MAIL_STATE_DIR": str(self.root)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        for name in migration.LEGACY_FILES:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        migration.migrate(self.source, self.root)

    def test_configuration_is_not_written_into_source(self):
        before = {str(path.relative_to(self.source)): path.read_bytes() for path in self.source.rglob("*") if path.is_file()}
        with patch.object(state, "run_service"):
            state.reconcile(snapshot())
        after = {str(path.relative_to(self.source)): path.read_bytes() for path in self.source.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(state.active_directory("dovecot").parent.parent, (self.root / "dovecot").resolve())

    def test_full_snapshot_keeps_all_tenants_and_aliases(self):
        with patch.object(state, "run_service"):
            state.reconcile(snapshot())
        users = (state.active_directory("dovecot") / "users").read_text()
        maps = (state.active_directory("postfix") / "virtual_mailbox_maps").read_text()
        self.assertIn("admin@one.example", users)
        self.assertIn("keep@two.example", users)
        self.assertIn("two.example/keep/Maildir/", maps)
        self.assertIn("help@one.example", (state.active_directory("postfix") / "virtual_alias_maps").read_text())

    def test_password_hashes_keep_argon_parameters_and_quota(self):
        content = state.passwd_lines(snapshot()["mailboxes"])
        self.assertIn("m=65536,t=3,p=1", content)
        self.assertIn("storage=512M", content)
        self.assertNotIn("{ARGON2ID}{ARGON2ID}", content)

    def test_failed_compilation_does_not_activate_or_reload(self):
        before = {name: (self.root / name / "active.conf").read_bytes() for name in ("postfix", "dovecot")}
        def failed(component, action, generation=None):
            if action == "prepare":
                raise state.MailStateError("MAIL_STATE_ACTIVATION_FAILED", "Compilation failed", phase="prepare")
        with patch.object(state, "run_service", side_effect=failed) as service:
            with self.assertRaises(state.MailStateError):
                state.reconcile(snapshot())
        self.assertTrue(all(call.args[1] == "prepare" for call in service.call_args_list))
        self.assertEqual(before, {name: (self.root / name / "active.conf").read_bytes() for name in before})

    def test_activation_failure_restores_both_previous_generations(self):
        before = {name: (self.root / name / "active.conf").read_bytes() for name in ("postfix", "dovecot")}
        failures = [True]
        def failed(component, action, generation=None):
            if component == "postfix" and action == "activate" and failures:
                failures.pop()
                raise state.MailStateError("MAIL_STATE_ACTIVATION_FAILED", "Reload failed")
        with patch.object(state, "run_service", side_effect=failed):
            with self.assertRaises(state.MailStateError) as caught:
                state.reconcile(snapshot())
        self.assertEqual(caught.exception.details["rollbackFailed"], [])
        self.assertEqual(before, {name: (self.root / name / "active.conf").read_bytes() for name in before})

    def generation_names(self):
        return {name: {path.name for path in (self.root / name / "generations").iterdir()}
                for name in ("postfix", "dovecot")}

    def test_repeated_prepare_failures_do_not_accumulate_generations(self):
        before = self.generation_names()
        for unavailable in ("postfix", "dovecot"):
            def failed(component, action, generation=None):
                if component == unavailable and action == "prepare":
                    raise state.MailStateError("MAIL_STATE_SERVICE_UNAVAILABLE", "Service unavailable")
            with patch.object(state, "run_service", side_effect=failed):
                for _ in range(4):
                    with self.assertRaises(state.MailStateError): state.reconcile(snapshot())
                    self.assertEqual(self.generation_names(), before)

    def test_partial_staging_failure_removes_all_unpublished_files(self):
        before = self.generation_names()
        write = state.atomic_write
        def failed(path, content, mode=0o600):
            if Path(path).name == "users": raise OSError("Disk full")
            return write(path, content, mode)
        with patch.object(state, "atomic_write", side_effect=failed):
            with self.assertRaises(state.MailStateError): state.reconcile(snapshot())
        self.assertEqual(self.generation_names(), before)

    def test_confirmed_rollback_discards_failed_generations(self):
        before = self.generation_names()
        failed_once = [True]
        def failed(component, action, generation=None):
            if component == "postfix" and action == "activate" and failed_once:
                failed_once.pop()
                raise state.MailStateError("MAIL_STATE_ACTIVATION_FAILED", "Reload failed")
        with patch.object(state, "run_service", side_effect=failed):
            with self.assertRaises(state.MailStateError): state.reconcile(snapshot())
        self.assertEqual(self.generation_names(), before)

    def test_unconfirmed_rollback_preserves_potentially_live_generations(self):
        before = self.generation_names()
        def failed(component, action, generation=None):
            if component == "postfix" and action == "activate":
                raise state.MailStateError("MAIL_STATE_ACTIVATION_FAILED", "Reload failed")
        with patch.object(state, "run_service", side_effect=failed):
            with self.assertRaises(state.MailStateError) as caught: state.reconcile(snapshot())
        self.assertEqual(caught.exception.details["rollbackFailed"], ["postfix"])
        after = self.generation_names()
        for component in before:
            self.assertTrue(before[component] < after[component])
            self.assertEqual(len(after[component]), len(before[component]) + 1)

    def test_discard_never_removes_an_active_generation(self):
        before = self.generation_names()
        state.discard_generations({component: state.active_generation(component) for component in before})
        self.assertEqual(self.generation_names(), before)

    def test_cleanup_failure_preserves_original_sync_error(self):
        error = state.MailStateError("MAIL_STATE_SERVICE_UNAVAILABLE", "Service unavailable")
        with patch.object(state, "run_service", side_effect=error), patch.object(state.shutil, "rmtree", side_effect=PermissionError("Denied")):
            with self.assertRaises(state.MailStateError) as caught: state.reconcile(snapshot())
        self.assertEqual(caught.exception.code, "MAIL_STATE_SERVICE_UNAVAILABLE")
        self.assertEqual(set(caught.exception.details["cleanupFailed"]), {"postfix", "dovecot"})

    def test_rollback_failure_is_reported(self):
        def failed(component, action, generation=None):
            if action == "activate": raise state.MailStateError("MAIL_STATE_ACTIVATION_FAILED", "Reload failed")
        with patch.object(state, "run_service", side_effect=failed):
            with self.assertRaises(state.MailStateError) as caught:
                state.reconcile(snapshot())
        self.assertEqual(set(caught.exception.details["rollbackFailed"]), {"postfix", "dovecot"})

    def test_generation_storage_is_bounded_after_success(self):
        with patch.object(state, "run_service"):
            for _ in range(5): state.reconcile(snapshot())
        for name in ("postfix", "dovecot"):
            self.assertEqual(len(list((self.root / name / "generations").iterdir())), 2)

    def test_invalid_tokens_and_hashes_are_rejected(self):
        for address in ("../user@one.example", "..@one.example", "a\nroot@one.example", "invalid", "a@other.example"):
            with self.subTest(address=address):
                data = snapshot()
                data["mailboxes"][0]["address"] = address
                with self.assertRaises(state.MailStateError): state.reconcile(data)
        with self.assertRaises(state.MailStateError):
            state.passwd_lines([{"address": "a@one.example", "passwordHash": "$hash\nroot:hash"}])

    @unittest.skipIf(os.name == "nt", "POSIX open-inode behavior is covered by the Linux integration suite")
    def test_atomic_replacement_is_visible_through_directory_mount_contract(self):
        path = self.root / "probe"
        state.atomic_write(path, "old")
        old = path.open("rb")
        try:
            state.atomic_write(path, "new")
            self.assertEqual(old.read(), b"old")
            self.assertEqual(path.read_bytes(), b"new")
        finally:
            old.close()

    def test_failed_atomic_write_preserves_old_file(self):
        path = self.root / "probe"
        state.atomic_write(path, "old")
        with patch.object(state.os, "replace", side_effect=OSError("forced")):
            with self.assertRaises(OSError): state.atomic_write(path, "new")
        self.assertEqual(path.read_text(), "old")

    def test_service_errors_are_structured_and_not_swallowed(self):
        with patch.object(state.subprocess, "run", return_value=Mock(returncode=1, stderr="Compilation failed")):
            with self.assertRaises(state.MailStateError) as caught:
                state.run_service("postfix", "prepare", "a" * 32)
        self.assertEqual(caught.exception.details["phase"], "prepare")
        self.assertEqual(caught.exception.code, "MAIL_STATE_ACTIVATION_FAILED")

    def test_stale_mounts_are_detected(self):
        results = [Mock(returncode=0), Mock(returncode=0, stdout="different  active.conf")]
        with patch.object(state.subprocess, "run", side_effect=results):
            with self.assertRaises(state.MailStateError) as caught: state.run_service("postfix", "health")
        self.assertEqual(caught.exception.code, "MAIL_STATE_MOUNT_STALE")

    def test_file_lock_serializes_processes_and_is_released(self):
        code = "from mail_state import state_lock; import sys\nwith state_lock():\n print('locked', flush=True)\n sys.stdin.readline()\n"
        process = subprocess.Popen([sys.executable, "-c", code], cwd=Path(__file__).parent,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "locked")
            with self.assertRaises(state.MailStateError) as caught:
                with state.state_lock(timeout=0.05): pass
            self.assertEqual(caught.exception.code, "MAIL_SYNC_BUSY")
            process.communicate("release\n", timeout=10)
            with state.state_lock(timeout=0.05): pass
        finally:
            if process.poll() is None: process.kill(); process.communicate()

    def test_failed_restore_does_not_prevent_other_service_recovery(self):
        previous = {name: (self.root / name / "active.conf").read_bytes() for name in ("postfix", "dovecot")}
        write = state.atomic_write
        def fail_restore(path, content, mode=0o600):
            if Path(path).resolve() == (self.root / "postfix/active.conf").resolve() and content == previous["postfix"]:
                raise OSError("forced restore failure")
            write(path, content, mode)
        failures = [True]
        def fail_activate(component, action, generation=None):
            if component == "postfix" and action == "activate" and failures:
                failures.pop()
                raise state.MailStateError("MAIL_STATE_ACTIVATION_FAILED", "Reload failed")
        with patch.object(state, "atomic_write", side_effect=fail_restore), patch.object(state, "run_service", side_effect=fail_activate):
            with self.assertRaises(state.MailStateError) as caught: state.reconcile(snapshot())
        self.assertEqual(caught.exception.details["rollbackFailed"], ["postfix"])
        self.assertEqual((self.root / "dovecot/active.conf").read_bytes(), previous["dovecot"])

    def test_legacy_migration_preserves_every_byte_and_messages(self):
        users = self.source / "docker/dovecot/config/users"
        users.write_text(state.passwd_lines(snapshot()["mailboxes"]))
        key = self.source / "docker/postfix/opendkim/keys/one.example/default.private"
        key.parent.mkdir(parents=True)
        key.write_bytes(b"private key fixture\n")
        table = self.source / "docker/postfix/opendkim/KeyTable"
        table.write_text("default._domainkey.one.example one.example:default:/etc/opendkim/keys/one.example/default.private\n")
        message = self.source / "docker/mail-data/vhosts/one.example/admin/Maildir/new/message"
        message.parent.mkdir(parents=True)
        message.write_bytes(b"existing message\n")
        certificate = self.source / "docker/mail-data/certs/cert.pem"
        certificate.parent.mkdir(parents=True)
        certificate.write_bytes(b"existing certificate fixture\n")
        target = self.root.parent / "migration-target"
        result = migration.migrate(self.source, target)
        self.assertEqual((target / "opendkim/keys/one.example/default.private").read_bytes(), key.read_bytes())
        self.assertEqual((target / "opendkim/KeyTable").read_bytes(), table.read_bytes())
        generation = (target / "dovecot/active.conf").read_text().splitlines()[0].split(":")[1]
        self.assertEqual((target / "dovecot/generations" / generation / "users").read_bytes(), users.read_bytes())
        self.assertEqual(message.read_bytes(), b"existing message\n")
        self.assertEqual(certificate.read_bytes(), b"existing certificate fixture\n")
        for name, checksum in json.loads((Path(result["backup"]) / "checksums.json").read_text()).items():
            self.assertEqual(hashlib.sha256((Path(result["backup"]) / name).read_bytes()).hexdigest(), checksum)

    def test_migration_is_repeatable_without_overwriting_active_state(self):
        before = (self.root / "postfix/active.conf").read_bytes()
        (self.source / "docker/postfix/config/virtual_domains").write_text("new.example\n")
        migration.migrate(self.source, self.root)
        self.assertEqual((self.root / "postfix/active.conf").read_bytes(), before)

    def test_migration_rejects_dangerous_runtime_locations(self):
        for root in (self.source, self.source / "runtime", Path(self.source.anchor)):
            with self.subTest(root=root), self.assertRaises(ValueError): migration.migrate(self.source, root)

    def test_cli_emits_structured_errors_without_a_live_service(self):
        data = snapshot()
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("postfix_manager.py")), "reconcile_locked"],
                                input=json.dumps(data) + "\n", capture_output=True, text=True)
        frames = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(frames[0], {"ready": True})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("code", frames[-1])
        self.assertNotIn("passwordHash", result.stdout)


if __name__ == "__main__": unittest.main()
