"""Refreshing the generated nginx.conf of already-deployed sites.

nginx.conf is written into a project's deploy/ directory at deploy time, so a
template change only reaches a site on its next deploy. refresh_nginx_conf_for
re-renders it for the site types that serve the project directory, in place
(the container bind-mounts that single file, so it must keep its inode), and
only when the content actually changes.
"""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "docker_manager_nginx_refresh", REPO_ROOT / "system" / "python" / "docker_manager.py"
)
dm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dm)

OLD_SPA_CONF = "server {\n    listen 80;\n    root /usr/share/nginx/html;\n    location / { try_files $uri /index.html; }\n}\n"
PROJECT_ID = "cmvabcdef012345678"


class RefreshNginxConfTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name) / "project"
        (self.project / "deploy").mkdir(parents=True)
        self.conf = self.project / "deploy" / "nginx.conf"

    def refresh(self, project_type, php_no_build=False):
        return dm.refresh_nginx_conf_for(self.project, project_type, PROJECT_ID, php_no_build)

    def test_a_stale_static_conf_gains_the_deny_rules(self):
        self.conf.write_text(OLD_SPA_CONF, encoding="utf-8")
        self.assertEqual(self.refresh("STATIC"), "updated")
        text = self.conf.read_text(encoding="utf-8")
        self.assertIn("location ^~ /deploy/ { return 404; }", text)
        self.assertIn("well-known", text)

    def test_react_is_treated_like_static(self):
        self.conf.write_text(OLD_SPA_CONF, encoding="utf-8")
        self.assertEqual(self.refresh("REACT"), "updated")

    def test_no_build_php_keeps_its_own_unique_upstream(self):
        self.conf.write_text("server { fastcgi_pass vexlyx-old-app-1:9000; }\n", encoding="utf-8")
        self.assertEqual(self.refresh("PHP", php_no_build=True), "updated")
        text = self.conf.read_text(encoding="utf-8")
        self.assertIn(f"fastcgi_pass vexlyx-{dm.slugify(PROJECT_ID[:12])}-app-1:9000;", text)
        self.assertNotIn("{{", text)
        self.assertIn("location ^~ /deploy/ { return 404; }", text)

    def test_a_second_run_changes_nothing(self):
        self.conf.write_text(OLD_SPA_CONF, encoding="utf-8")
        self.refresh("STATIC")
        before = self.conf.stat().st_mtime_ns
        self.assertEqual(self.refresh("STATIC"), "unchanged")
        self.assertEqual(self.conf.stat().st_mtime_ns, before)

    @unittest.skipUnless(os.name == "posix", "inodes are a POSIX concern")
    def test_the_file_keeps_its_inode_so_the_container_mount_sees_it(self):
        self.conf.write_text(OLD_SPA_CONF, encoding="utf-8")
        inode = self.conf.stat().st_ino
        self.refresh("STATIC")
        self.assertEqual(self.conf.stat().st_ino, inode)

    def test_a_project_that_was_never_deployed_is_skipped(self):
        self.assertEqual(self.refresh("STATIC"), "skipped")
        self.assertFalse(self.conf.exists())

    def test_other_project_types_are_skipped(self):
        self.conf.write_text("keep me\n", encoding="utf-8")
        for project_type in ("NODEJS", "NEXTJS", "PYTHON", "DOCKER", "WORDPRESS"):
            self.assertEqual(self.refresh(project_type), "skipped", project_type)
        self.assertEqual(self.refresh("PHP", php_no_build=False), "skipped")
        self.assertEqual(self.conf.read_text(encoding="utf-8"), "keep me\n")

    @unittest.skipUnless(os.name == "posix", "symlinks")
    def test_a_symlinked_deploy_directory_is_skipped(self):
        elsewhere = Path(self._tmp.name) / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "nginx.conf").write_text("outside\n", encoding="utf-8")
        (self.project / "deploy" / "nginx.conf").unlink(missing_ok=True)
        (self.project / "deploy").rmdir()
        (self.project / "deploy").symlink_to(elsewhere)
        self.assertEqual(self.refresh("STATIC"), "skipped")
        self.assertEqual((elsewhere / "nginx.conf").read_text(encoding="utf-8"), "outside\n")

    @unittest.skipUnless(os.name == "posix", "symlinks")
    def test_a_symlinked_conf_is_never_written_through(self):
        target = Path(self._tmp.name) / "target.conf"
        target.write_text("outside\n", encoding="utf-8")
        self.conf.symlink_to(target)
        self.assertEqual(self.refresh("STATIC"), "skipped")
        self.assertEqual(target.read_text(encoding="utf-8"), "outside\n")


if __name__ == "__main__":
    unittest.main()
