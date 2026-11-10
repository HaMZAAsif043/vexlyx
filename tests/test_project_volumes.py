"""Named-volume rendering, isolation, and explicit data lifecycle (#157)."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("volume_manager", ROOT / "system/python/docker_manager.py")
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class ProjectVolumes(unittest.TestCase):
    def test_names_are_stable_and_private(self):
        first = manager.named_volume_placeholders("project-a", ["/data", "/uploads"])
        reordered = manager.named_volume_placeholders("project-a", ["/uploads", "/data"])
        self.assertEqual(set(first["volume_mounts"].splitlines()), set(reordered["volume_mounts"].splitlines()))
        self.assertNotEqual(first["volume_definitions"], manager.named_volume_placeholders("project-b", ["/data", "/uploads"])["volume_definitions"])

    def test_rejects_mount_options_traversal_and_overlaps(self):
        for paths in [["/"], ["/data:ro"], ["/a/../data"], ["relative"], ["/a", "/a/b"], ["/a", "/a"], [None]]:
            with self.subTest(paths=paths), patch.object(manager, "fail", side_effect=ValueError), self.assertRaises(ValueError):
                manager.named_volume_placeholders("project", paths)

    def test_render_without_volumes_has_no_placeholders(self):
        with tempfile.TemporaryDirectory() as directory:
            manager.generate_compose_file(Path(directory), ROOT / "system/templates/docker-compose/docker.yml", "alpine", "test", "test.example.com", 8999, 80, "128m", {})
            rendered = (Path(directory) / "docker-compose.yml").read_text()
            self.assertNotIn("{{volume_", rendered)
            self.assertNotIn("volumes:", rendered)

    def test_keep_data_does_not_delete_volumes(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "deploy").mkdir()
            with patch.object(manager, "get_docker_binary", return_value="docker"), patch.object(manager, "run_compose") as compose, patch.object(manager.subprocess, "run") as run, patch.object(manager, "respond"):
                manager.cmd_remove({"command": "remove-container", "projectDir": directory})
                self.assertNotIn("--volumes", compose.call_args.args[1])
                run.assert_not_called()

    def test_data_removal_targets_only_project_owned_volumes(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "deploy").mkdir()
            with patch.object(manager, "get_docker_binary", return_value="docker"), patch.object(manager, "run_compose") as compose, patch.object(manager.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0, "owned-volume\n", ""), subprocess.CompletedProcess([], 0, "", "")]) as run, patch.object(manager, "respond"):
                manager.cmd_remove({"command": "remove", "projectDir": directory})
                self.assertIn("--volumes", compose.call_args.args[1])
                self.assertIn("label=vexlyx.project=" + Path(directory).name, run.call_args_list[0].args[0])
                self.assertEqual(run.call_args_list[1].args[0], ["docker", "volume", "rm", "owned-volume"])

    @unittest.skipUnless(os.environ.get("VEXLYX_DOCKER_TESTS") == "1", "requires Docker; enabled in CI")
    def test_real_compose_preserves_data_then_explicitly_deletes_it(self):
        project = "volume-test-" + uuid.uuid4().hex
        def docker(*args):
            return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT, timeout=120)
        with tempfile.TemporaryDirectory(prefix=project) as directory:
            deploy = Path(directory) / "deploy"
            extra = manager.named_volume_placeholders(Path(directory).name, ["/data"])
            manager.generate_compose_file(deploy, ROOT / "system/templates/docker-compose/docker.yml", "alpine:3.21", project, "test.example.com", 18999, 80, "128m", {}, extra)
            compose = ["compose", "-f", str(deploy / "docker-compose.yml")]
            try:
                config = json.loads(docker(*compose, "config", "--format", "json"))
                config["services"]["app"]["command"] = ["sh", "-c", "sleep 600"]
                config["services"]["app"].pop("ports", None)
                config["networks"] = {"default": {}}
                (deploy / "docker-compose.yml").write_text(json.dumps(config))
                docker(*compose, "up", "-d")
                docker(*compose, "exec", "-T", "app", "sh", "-c", "echo upload > /data/upload.txt")
                docker(*compose, "up", "-d", "--force-recreate")
                self.assertEqual(docker(*compose, "exec", "-T", "app", "cat", "/data/upload.txt").strip(), "upload")
                manager.cmd_remove({"command": "remove-container", "projectDir": directory})
                docker(*compose, "up", "-d")
                self.assertEqual(docker(*compose, "exec", "-T", "app", "cat", "/data/upload.txt").strip(), "upload")
                names = list(config["volumes"].values())
                manager.cmd_remove({"command": "remove", "projectDir": directory})
                for volume in names:
                    self.assertNotEqual(subprocess.run(["docker", "volume", "inspect", volume["name"]], capture_output=True).returncode, 0)
            finally:
                docker(*compose, "down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    unittest.main()
