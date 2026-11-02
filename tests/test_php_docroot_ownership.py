"""PHP-FPM can write to its docroot, and only to its docroot (#151).

The API runs as root and creates a project directory as root:root 0755, while
PHP-FPM in the vexlyx-php-fpm and wordpress images runs as www-data (uid 82).
Self-installing apps (a Duplicator migration) then cannot create files. Deploys
hand the directory PHP serves to uid 82 (the directory itself, not its
contents), and keep the panel-owned deploy/ directory out of PHP's reach.
"""

import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCKER_MANAGER = REPO_ROOT / "system" / "python" / "docker_manager.py"
TEMPLATES_DIR = REPO_ROOT / "system" / "templates" / "docker-compose"


def load_docker_manager():
    spec = importlib.util.spec_from_file_location("docker_manager_under_test", DOCKER_MANAGER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dm = load_docker_manager()
IS_POSIX = os.name == "posix"


class Recorder:
    """Stands in for chown: remembers which directories would be handed over."""

    def __init__(self):
        self.paths = []

    def __call__(self, path, uid, gid):
        self.paths.append((Path(path).name, uid, gid))


class PhpIdentityTest(unittest.TestCase):
    def test_php_fpm_runs_as_82(self):
        self.assertEqual((dm.PHP_FPM_UID, dm.PHP_FPM_GID), (82, 82))


@unittest.skipUnless(IS_POSIX, "directory file descriptors are POSIX only")
class HandDocrootToPhpTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name) / "project"
        self.project.mkdir()
        (self.project / "deploy").mkdir()
        (self.project / "index.php").write_text("<?php")
        (self.project / "sub").mkdir()

    def hand(self, project_type, php_no_build=False):
        recorder = Recorder()
        changed = dm.hand_docroot_to_php(self.project, project_type, php_no_build, chown=recorder)
        return changed, recorder

    def test_no_build_php_hands_over_only_the_project_directory(self):
        changed, recorder = self.hand("PHP", php_no_build=True)
        self.assertEqual([p.name for p in changed], ["project"])
        self.assertEqual(recorder.paths, [("project", 82, 82)])

    def test_a_git_checkout_root_is_never_handed_over(self):
        # git, run as root by the panel, refuses a repository whose directory
        # another user owns ("dubious ownership"), and if PHP owned the root it
        # could replace .git (hooks and config then run as root on the next pull).
        (self.project / ".git").mkdir()
        changed, recorder = self.hand("PHP", php_no_build=True)
        self.assertEqual(changed, [])
        self.assertEqual(recorder.paths, [])

    def test_a_worktree_style_gitlink_file_counts_as_a_checkout_too(self):
        (self.project / ".git").write_text("gitdir: /somewhere/else\n")
        changed, recorder = self.hand("PHP", php_no_build=True)
        self.assertEqual(changed, [])
        self.assertEqual(recorder.paths, [])

    def test_a_dangling_git_symlink_counts_as_a_checkout(self):
        (self.project / ".git").symlink_to(Path(self._tmp.name) / "does-not-exist")
        changed, recorder = self.hand("PHP", php_no_build=True)
        self.assertEqual(changed, [])

    def test_a_plain_no_build_project_without_git_still_gets_it(self):
        (self.project / "gitignore-ish").mkdir()
        (self.project / ".gitignore").write_text("x")  # a file that merely looks similar
        changed, recorder = self.hand("PHP", php_no_build=True)
        self.assertEqual([p.name for p in changed], ["project"])
        self.assertEqual(recorder.paths, [("project", 82, 82)])

    def test_wordpress_scope_is_unchanged_by_a_git_directory(self):
        (self.project / ".git").mkdir()
        (self.project / "wp-content").mkdir()
        changed, _ = self.hand("WORDPRESS")
        self.assertEqual([p.name for p in changed], ["wp-content"])

    def test_nixpacks_built_php_is_left_alone(self):
        changed, recorder = self.hand("PHP", php_no_build=False)
        self.assertEqual(changed, [])
        self.assertEqual(recorder.paths, [])

    def test_other_types_are_left_alone(self):
        for project_type in ("NODEJS", "NEXTJS", "PYTHON", "STATIC", "REACT", "DOCKER"):
            changed, _ = self.hand(project_type)
            self.assertEqual(changed, [], project_type)

    def test_wordpress_hands_over_wp_content_and_its_standard_folders(self):
        for name in ("plugins", "themes", "uploads"):
            (self.project / "wp-content" / name).mkdir(parents=True)
        (self.project / "wp-content" / "themes" / "twenty").mkdir()
        changed, _ = self.hand("WORDPRESS")
        self.assertEqual(
            sorted(p.relative_to(self.project).as_posix() for p in changed),
            ["wp-content", "wp-content/plugins", "wp-content/themes", "wp-content/uploads"],
        )

    def test_wordpress_skips_folders_that_do_not_exist(self):
        (self.project / "wp-content").mkdir()
        changed, _ = self.hand("WORDPRESS")
        self.assertEqual([p.name for p in changed], ["wp-content"])

    def test_a_symlink_is_never_followed(self):
        outside = Path(self._tmp.name) / "outside"
        outside.mkdir()
        (self.project / "wp-content").mkdir()
        (self.project / "wp-content" / "uploads").symlink_to(outside)
        changed, recorder = self.hand("WORDPRESS")
        self.assertEqual([p.name for p in changed], ["wp-content"])
        self.assertNotIn("outside", [name for name, _, _ in recorder.paths])

    def test_a_missing_wp_content_is_not_an_error(self):
        changed, _ = self.hand("WORDPRESS")
        self.assertEqual(changed, [])

    def test_the_deploy_directory_is_never_handed_over(self):
        changed, recorder = self.hand("PHP", php_no_build=True)
        self.assertNotIn("deploy", [name for name, _, _ in recorder.paths])
        self.assertTrue(all(p.name != "deploy" for p in changed))

    def test_without_root_it_skips_instead_of_failing(self):
        if not hasattr(os, "geteuid") or os.geteuid() == 0:
            self.skipTest("only meaningful for a non-root user")
        changed = dm.hand_docroot_to_php(self.project, "PHP", True)
        self.assertEqual(changed, [])

    @unittest.skipUnless(IS_POSIX and hasattr(os, "geteuid") and os.geteuid() == 0, "needs root")
    def test_real_ownership_change_is_not_recursive_and_leaves_deploy_alone(self):
        dm.hand_docroot_to_php(self.project, "PHP", True)
        self.assertEqual(self.project.stat().st_uid, 82)
        self.assertEqual((self.project / "deploy").stat().st_uid, 0)
        self.assertEqual((self.project / "index.php").stat().st_uid, 0)
        self.assertFalse(self.project.stat().st_mode & stat.S_IWOTH)


@unittest.skipUnless(IS_POSIX, "symlinks")
class DeployDirectorySafetyTest(unittest.TestCase):
    """PHP owns the project directory, so it could swap deploy/ for a symlink
    and have the root-run deploy write the compose file somewhere else."""

    def test_a_symlinked_deploy_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "elsewhere"
            target.mkdir()
            deploy = Path(tmp) / "deploy"
            deploy.symlink_to(target)
            with self.assertRaises(SystemExit):
                dm.assert_deploy_dir_is_not_a_symlink(deploy)

    def test_a_real_or_missing_deploy_directory_is_fine(self):
        with tempfile.TemporaryDirectory() as tmp:
            dm.assert_deploy_dir_is_not_a_symlink(Path(tmp) / "missing")
            (Path(tmp) / "deploy").mkdir()
            dm.assert_deploy_dir_is_not_a_symlink(Path(tmp) / "deploy")


class PhpNoBuildTemplateTest(unittest.TestCase):
    def test_php_fpm_sees_deploy_read_only_and_as_a_mount_point(self):
        text = (TEMPLATES_DIR / "php-no-build.yml").read_text(encoding="utf-8").replace("\r\n", "\n")
        app = text.split("\n  app:\n", 1)[1].split("\n  web:\n", 1)[0]
        # A bind mount over deploy/ cannot be renamed or removed from inside
        # the container, and read-only keeps it unwritable.
        self.assertIn('- "{{deploy_dir}}:/var/www/html/deploy:ro"', app)
        self.assertIn('- "{{php_root}}:/var/www/html"', app)


class InstallerWiringTest(unittest.TestCase):
    def test_step_14_runs_the_one_time_repair_without_failing_the_install(self):
        step = (REPO_ROOT / "system/scripts/install/steps/14-services-up.sh").read_text(encoding="utf-8")
        line = next(l for l in step.splitlines() if "hand-docroots-to-php" in l)
        self.assertIn("exec -T api node dist/scripts/hand-docroots-to-php.js", line)
        # Followed by an `|| log_warn` so a failure cannot abort the upgrade.
        self.assertIn("|| log_warn", step.split(line, 1)[1].splitlines()[1])


if __name__ == "__main__":
    unittest.main()
