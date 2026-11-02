"""Release-channel behaviour of install.sh: which tag or branch gets installed.

install.sh only runs main() when executed, so these tests source it and call the
functions against a throwaway local git repository with a known set of tags.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
INSTALL_SH = ROOT_DIR / "install.sh"

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def git(cwd: Path, *args: str) -> str:
    env = {**os.environ, **GIT_ENV}
    result = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


class InstallerReleaseChannelTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bash = shutil.which("bash")
        if not self.bash or not shutil.which("git"):
            self.skipTest("bash and git are required")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.origin = self.tmp / "origin"
        self.origin.mkdir()
        git(self.origin, "init", "--quiet", "--initial-branch=main")

    def commit(self, label: str, tag: str | None = None) -> None:
        (self.origin / "MARK").write_text(label, encoding="utf-8")
        git(self.origin, "add", "MARK")
        git(self.origin, "commit", "--quiet", "-m", label)
        if tag:
            git(self.origin, "tag", tag)

    def seed_releases(self) -> None:
        self.commit("release-0.9.0", "v0.9.0")
        self.commit("release-0.10.0", "v0.10.0")
        self.commit("prerelease", "v0.11.0-rc.1")
        self.commit("nightly", "nightly")
        self.commit("main-tip")

    @property
    def url(self) -> str:
        return self.origin.as_uri()

    def run_script(self, body: str, cwd: Path | None = None, ref: str | None = None) -> subprocess.CompletedProcess:
        env = {**os.environ, **GIT_ENV, "VEXLYX_REPO_URL": self.url, "VEXLYX_HOME": str(self.tmp / "home")}
        env.pop("VEXLYX_REPO_REF", None)
        if ref is not None:
            env["VEXLYX_REPO_REF"] = ref
        script = f'source "{INSTALL_SH.as_posix()}"; {body}'
        return subprocess.run([self.bash, "-c", script], cwd=cwd, env=env, capture_output=True, text=True)

    def checkout_mark(self, path: Path) -> str:
        return (path / "MARK").read_text(encoding="utf-8")

    def fresh_clone(self, ref: str | None = None) -> Path:
        result = self.run_script("fresh_checkout", ref=ref)
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.tmp / "home"

    # -- choosing the release ------------------------------------------------

    def test_latest_release_tag_uses_version_order_and_skips_prereleases(self) -> None:
        self.seed_releases()
        result = self.run_script("latest_release_tag")
        self.assertEqual(result.stdout.strip(), "v0.10.0")  # not v0.9.0, not -rc, not "nightly"

    def test_latest_release_tag_is_empty_without_stable_tags(self) -> None:
        self.commit("only-main")
        git(self.origin, "tag", "v1.0.0-rc.1")
        self.assertEqual(self.run_script("latest_release_tag").stdout.strip(), "")

    # -- fresh installs ------------------------------------------------------

    def test_fresh_install_defaults_to_the_latest_release_not_main(self) -> None:
        self.seed_releases()
        home = self.fresh_clone()
        self.assertEqual(self.checkout_mark(home), "release-0.10.0")
        self.assertEqual(git(home, "describe", "--tags", "--exact-match"), "v0.10.0")

    def test_fresh_install_can_pin_a_specific_release(self) -> None:
        self.seed_releases()
        home = self.fresh_clone(ref="v0.9.0")
        self.assertEqual(self.checkout_mark(home), "release-0.9.0")

    def test_fresh_install_can_still_follow_a_branch(self) -> None:
        self.seed_releases()
        home = self.fresh_clone(ref="main")
        self.assertEqual(self.checkout_mark(home), "main-tip")
        self.assertEqual(git(home, "symbolic-ref", "--short", "HEAD"), "main")

    def test_fresh_install_falls_back_to_main_when_no_release_exists(self) -> None:
        self.commit("only-main")
        result = self.run_script("fresh_checkout")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("falling back to the main branch", result.stderr)
        self.assertEqual(self.checkout_mark(self.tmp / "home"), "only-main")

    # -- re-running on an existing install -----------------------------------

    def test_rerun_moves_a_release_install_to_the_newer_release(self) -> None:
        self.seed_releases()
        home = self.fresh_clone(ref="v0.9.0")
        result = self.run_script("update_checkout", cwd=home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checkout_mark(home), "release-0.10.0")

    def test_rerun_on_the_current_release_changes_nothing(self) -> None:
        self.seed_releases()
        home = self.fresh_clone()
        result = self.run_script("update_checkout", cwd=home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Already on release v0.10.0", result.stdout)

    def test_rerun_picks_up_a_release_published_after_install(self) -> None:
        self.seed_releases()
        home = self.fresh_clone()
        self.commit("release-0.10.1", "v0.10.1")
        self.assertEqual(self.run_script("update_checkout", cwd=home).returncode, 0)
        self.assertEqual(self.checkout_mark(home), "release-0.10.1")

    def test_existing_branch_install_keeps_following_its_branch_by_default(self) -> None:
        self.seed_releases()
        home = self.fresh_clone(ref="main")
        self.commit("main-newer")
        result = self.run_script("update_checkout", cwd=home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checkout_mark(home), "main-newer")
        self.assertEqual(git(home, "symbolic-ref", "--short", "HEAD"), "main")

    def test_branch_install_switches_to_releases_only_when_asked(self) -> None:
        self.seed_releases()
        home = self.fresh_clone(ref="main")
        result = self.run_script("update_checkout", cwd=home, ref="latest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checkout_mark(home), "release-0.10.0")

    def test_local_changes_are_never_overwritten(self) -> None:
        self.seed_releases()
        home = self.fresh_clone(ref="v0.9.0")
        (home / "MARK").write_text("edited by the operator", encoding="utf-8")
        result = self.run_script("update_checkout", cwd=home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Local changes detected", result.stdout)
        self.assertEqual(self.checkout_mark(home), "edited by the operator")

    def seed_with_tracked_script(self) -> Path:
        script = self.origin / "tool.sh"
        script.write_text("#!/bin/sh\n", encoding="utf-8")
        git(self.origin, "add", "tool.sh")
        self.seed_releases()
        return self.fresh_clone(ref="v0.9.0")

    def test_untracked_files_do_not_stop_an_upgrade(self) -> None:
        home = self.seed_with_tracked_script()
        (home / ".pnpm-store").mkdir()
        (home / ".pnpm-store" / "index").write_text("cache", encoding="utf-8")
        result = self.run_script("update_checkout", cwd=home, ref="v0.10.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Local changes detected", result.stdout)
        self.assertEqual(self.checkout_mark(home), "release-0.10.0")

    @unittest.skipIf(os.name == "nt", "file modes are not meaningful on Windows")
    def test_mode_only_changes_do_not_stop_an_upgrade(self) -> None:
        # v0.3.x servers: the OpenDKIM entrypoint runs chmod -R on tracked key files.
        home = self.seed_with_tracked_script()
        git(home, "config", "core.fileMode", "true")
        (home / "tool.sh").chmod(0o755)
        self.assertIn("tool.sh", git(home, "status", "--porcelain"))
        result = self.run_script("update_checkout", cwd=home, ref="v0.10.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Local changes detected", result.stdout)
        self.assertEqual(self.checkout_mark(home), "release-0.10.0")

    @unittest.skipIf(os.name == "nt", "file modes are not meaningful on Windows")
    def test_a_real_edit_still_stops_an_upgrade_even_with_a_mode_change(self) -> None:
        home = self.seed_with_tracked_script()
        git(home, "config", "core.fileMode", "true")
        (home / "tool.sh").chmod(0o755)
        (home / "tool.sh").write_text("#!/bin/sh\necho edited\n", encoding="utf-8")
        result = self.run_script("update_checkout", cwd=home, ref="v0.10.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Local changes detected", result.stdout)
        self.assertEqual(self.checkout_mark(home), "release-0.9.0")

    def test_mail_state_check_ignores_untracked_files(self) -> None:
        home = self.seed_with_tracked_script()
        (home / ".pnpm-store").mkdir()
        (home / ".pnpm-store" / "index").write_text("cache", encoding="utf-8")
        result = self.run_script(
            "git fetch --quiet origin tag v0.10.0 && prepare_mail_upgrade", cwd=home
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("Source changes detected", result.stderr)

    @unittest.skipIf(os.name == "nt", "file modes are not meaningful on Windows")
    def test_mail_state_check_ignores_mode_only_changes(self) -> None:
        home = self.seed_with_tracked_script()
        git(home, "config", "core.fileMode", "true")
        (home / "tool.sh").chmod(0o755)
        result = self.run_script(
            "git fetch --quiet origin tag v0.10.0 && prepare_mail_upgrade", cwd=home
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("Source changes detected", result.stderr)

    def test_mail_state_check_still_refuses_a_real_source_edit(self) -> None:
        home = self.seed_with_tracked_script()
        (home / "MARK").write_text("edited by the operator", encoding="utf-8")
        result = self.run_script(
            "git fetch --quiet origin tag v0.10.0 && prepare_mail_upgrade", cwd=home
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Source changes detected", result.stderr)
        self.assertEqual(self.checkout_mark(home), "edited by the operator")

    def test_old_install_with_the_tracked_users_file_gets_the_upgrade_pointer(self) -> None:
        (self.origin / "docker/dovecot/config").mkdir(parents=True)
        (self.origin / "docker/dovecot/config/users").write_text("old fixture\n", encoding="utf-8")
        git(self.origin, "add", "-A")
        self.commit("release-with-tracked-users", "v0.1.0")
        home = self.fresh_clone(ref="v0.1.0")
        (home / "docker/dovecot/config/users").write_text("rewritten by the panel\n", encoding="utf-8")
        result = self.run_script("update_checkout", cwd=home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Local changes detected", result.stdout)
        self.assertIn("mail-credential-remediation.md", result.stdout)

    def test_main_does_nothing_when_the_file_is_only_sourced(self) -> None:
        result = self.run_script("echo sourced-ok")
        self.assertEqual(result.stdout.strip(), "sourced-ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
