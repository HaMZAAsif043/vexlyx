"""Cleanup failure boundaries without executing Docker (#55)."""
import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("cleanup_docker_manager", Path(__file__).parents[1] / "system/python/docker_manager.py")
manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manager)


class CleanupFailureTests(unittest.TestCase):
    def run_cleanup(self, results):
        with patch.object(manager, "get_docker_binary", return_value="docker"), patch.object(manager, "run_bounded", side_effect=results) as run, patch.object(manager, "respond") as respond, patch.object(manager, "fail") as fail, patch.object(manager, "log_line"):
            manager.cmd_cleanup({})
            return run, respond, fail

    def test_container_failure_aborts_before_image_prune(self):
        run, respond, fail = self.run_cleanup([subprocess.CompletedProcess([], 1, "", "daemon unavailable")])
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[1], ["docker", "container", "prune", "-f"])
        self.assertEqual(fail.call_args.args[1], "CONTAINER_PRUNE_FAILED")
        respond.assert_not_called()

    def test_image_failure_does_not_report_success(self):
        run, respond, fail = self.run_cleanup([subprocess.CompletedProcess([], 0, "", ""), subprocess.CompletedProcess([], 1, "", "image prune failed")])
        self.assertEqual(run.call_count, 2)
        self.assertEqual(fail.call_args.args[1], "IMAGE_PRUNE_FAILED")
        respond.assert_not_called()

    def test_success_prunes_only_containers_and_images(self):
        run, respond, fail = self.run_cleanup([subprocess.CompletedProcess([], 0, "abcdef123456\nTotal reclaimed space: 1kB", ""), subprocess.CompletedProcess([], 0, "deleted: sha256:abc\nTotal reclaimed space: 2kB", "")])
        self.assertEqual([call.args[1] for call in run.call_args_list], [["docker", "container", "prune", "-f"], ["docker", "image", "prune", "-a", "-f"]])
        self.assertTrue(all(call.args[0] == manager.PRUNE_TIMEOUT for call in run.call_args_list))
        fail.assert_not_called()
        respond.assert_called_once_with({"done": True, "containersRemoved": 1, "imagesRemoved": 1, "reclaimedBytes": 3000})


if __name__ == "__main__":
    unittest.main()
