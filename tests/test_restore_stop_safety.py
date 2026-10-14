import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "docker_manager", Path(__file__).parents[1] / "system/python/docker_manager.py"
)
docker_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(docker_manager)


def result(output="", code=0):
    return subprocess.CompletedProcess([], code, output, "")


class RestoreStopSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        (Path(self.temp.name) / "deploy").mkdir()
        self.payload = {"projectDir": self.temp.name}
        for name in ("get_docker_binary", "run_compose", "respond", "log_line"):
            mock = self.enterContext(patch.object(docker_manager, name))
            setattr(self, name, mock)
        self.get_docker_binary.return_value = "docker"
        self.run = self.enterContext(patch.object(docker_manager.subprocess, "run"))

    def assert_rejected(self):
        with self.assertRaises(SystemExit), patch("builtins.print") as output:
            docker_manager.cmd_stop(self.payload)
        self.respond.assert_not_called()
        self.assertIn("CONTAINER_STOP_UNCONFIRMED", output.call_args.args[0])

    def test_confirms_all_services_before_success(self):
        self.run.side_effect = [result("web\napp\n"), result("exited\nexited\n")]
        docker_manager.cmd_stop(self.payload)
        self.assertEqual(self.run.call_args_list[0].args[0], ["docker", "compose", "ps", "--all", "--quiet"])
        self.assertEqual(self.run.call_args.args[0][-2:], ["web", "app"])
        self.respond.assert_called_once_with({"done": True})

    def test_empty_stack_is_safe_after_successful_listing(self):
        self.run.return_value = result()
        docker_manager.cmd_stop(self.payload)
        self.run.assert_called_once()
        self.respond.assert_called_once_with({"done": True})

    def test_rejects_active_or_unknown_sidecar(self):
        for status in ("running", "paused", "restarting", "removing", "unknown"):
            with self.subTest(status=status):
                self.run.side_effect = [result("web\napp\n"), result(f"exited\n{status}\n")]
                self.assert_rejected()

    def test_listing_error_is_not_an_empty_stack(self):
        self.run.return_value = result(code=1)
        self.assert_rejected()

    def test_failed_or_incomplete_inspection_aborts(self):
        for response in (result(code=1), result(), result("exited\n")):
            with self.subTest(response=response):
                self.run.side_effect = [result("web\napp\n"), response]
                self.assert_rejected()

    def test_timeout_and_spawn_failure_abort(self):
        for error in (subprocess.TimeoutExpired("docker", 30), OSError("unavailable")):
            with self.subTest(error=error):
                self.run.side_effect = error
                self.assert_rejected()

    def test_stop_failure_never_reports_success(self):
        self.run_compose.side_effect = SystemExit(1)
        with self.assertRaises(SystemExit):
            docker_manager.cmd_stop(self.payload)
        self.run.assert_not_called()
        self.respond.assert_not_called()



class StopByProjectTests(unittest.TestCase):
    """Stopping a project by identity when its workspace (compose file) is gone."""

    PROJECT_ID = "0123456789abcdef-long-project-id"

    def setUp(self):
        for name in ("get_docker_binary", "respond", "log_line"):
            mock = self.enterContext(patch.object(docker_manager, name))
            setattr(self, name, mock)
        self.get_docker_binary.return_value = "docker"
        self.run = self.enterContext(patch.object(docker_manager.subprocess, "run"))

    def call(self):
        docker_manager.cmd_stop_by_project({"projectId": self.PROJECT_ID})

    def assert_rejected(self):
        with self.assertRaises(SystemExit), patch("builtins.print") as output:
            self.call()
        self.respond.assert_not_called()
        self.assertIn("CONTAINER_STOP_UNCONFIRMED", output.call_args.args[0])

    def test_finds_containers_by_compose_project_label(self):
        self.run.return_value = result()
        self.call()
        listing = self.run.call_args_list[0].args[0]
        expected = f"label=com.docker.compose.project=vexlyx-{docker_manager.slugify(self.PROJECT_ID[:12])}"
        self.assertIn(expected, listing)
        self.assertIn("--all", listing)

    def test_no_containers_is_a_success_without_stopping_anything(self):
        self.run.return_value = result()
        self.call()
        self.run.assert_called_once()
        self.respond.assert_called_once_with({"done": True})

    def test_already_stopped_containers_are_not_stopped_again(self):
        self.run.return_value = result("aaa exited\nbbb created\n")
        self.call()
        self.run.assert_called_once()
        self.respond.assert_called_once_with({"done": True})

    def test_stops_active_containers_and_verifies(self):
        self.run.side_effect = [
            result("aaa running\nbbb exited\nccc paused\n"),
            result(),  # docker stop
            result("aaa exited\nbbb exited\nccc exited\n"),
        ]
        self.call()
        self.assertEqual(self.run.call_args_list[1].args[0], ["docker", "stop", "aaa", "ccc"])
        self.respond.assert_called_once_with({"done": True})

    def test_container_still_active_after_stop_is_rejected(self):
        self.run.side_effect = [
            result("aaa running\n"),
            result(),
            result("aaa running\n"),
        ]
        self.assert_rejected()

    def test_failed_stop_is_rejected(self):
        self.run.side_effect = [result("aaa running\n"), result(code=1)]
        self.assert_rejected()

    def test_listing_failure_is_not_an_empty_project(self):
        self.run.return_value = result(code=1)
        self.assert_rejected()

    def test_timeout_is_rejected(self):
        self.run.side_effect = subprocess.TimeoutExpired("docker", 30)
        self.assert_rejected()


if __name__ == "__main__":
    unittest.main()
