"""Generated-file and Compose access must survive a deploy-directory swap."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "docker_manager_swap", Path(__file__).parents[1] / "system/python/docker_manager.py"
)
dm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dm)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux directory descriptors and /proc")
class DeployDirectorySwapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.deploy = self.root / "deploy"
        self.deploy.mkdir()
        self.outside = self.root / "outside"
        self.outside.mkdir()
        (self.deploy / "docker-compose.yml").write_text("trusted")
        (self.outside / "docker-compose.yml").write_text("sentinel")

    def swap(self):
        self.deploy.rename(self.root / "original")
        self.deploy.symlink_to(self.outside, target_is_directory=True)

    def test_swap_after_initial_check_never_overwrites_outside_file(self):
        dm.assert_deploy_dir_is_not_a_symlink(self.deploy)
        self.swap()
        with self.assertRaises(SystemExit):
            dm.write_generated_file(self.deploy / "docker-compose.yml", "replacement")
        self.assertEqual((self.outside / "docker-compose.yml").read_text(), "sentinel")

    def test_swap_after_opening_parent_writes_only_to_the_pinned_directory(self):
        original_open = os.open
        def exchange_after_open(name, flags, *args, **kwargs):
            descriptor = original_open(name, flags, *args, **kwargs)
            if Path(name) == self.deploy:
                self.swap()
            return descriptor
        with patch.object(dm.os, "open", side_effect=exchange_after_open):
            dm.write_generated_file(self.deploy / "docker-compose.yml", "replacement")
        self.assertEqual((self.root / "original/docker-compose.yml").read_text(), "replacement")
        self.assertEqual((self.outside / "docker-compose.yml").read_text(), "sentinel")

    def test_compose_client_uses_pinned_directory_even_if_name_is_replaced_before_spawn(self):
        real_popen = subprocess.Popen
        def exchange_before_spawn(*args, **kwargs):
            self.swap()
            return real_popen(*args, **kwargs)
        with patch.object(dm.subprocess, "Popen", side_effect=exchange_before_spawn):
            process = dm.spawn_with_safe_cwd(
                [sys.executable, "-c", "from pathlib import Path; print(Path('docker-compose.yml').read_text())"],
                cwd=self.deploy, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
        with process:
            output, error = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, error)
        self.assertEqual(output.strip(), "trusted")

    def test_compose_client_refuses_a_directory_already_replaced_by_a_link(self):
        self.swap()
        with patch.object(dm.subprocess, "Popen") as popen:
            with self.assertRaises(SystemExit):
                dm.spawn_with_safe_cwd(["docker", "compose", "up"], cwd=self.deploy)
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
