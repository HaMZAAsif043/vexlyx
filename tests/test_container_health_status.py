"""
Container-health tests for docker_manager.py (#202).

`cmd_status` used to inspect only `.State.Status`, so a container that Docker
itself marked *unhealthy* still reached the panel as a plain "Running"
deployment and the only symptom was a 502 in the browser.

Run with: python tests/test_container_health_status.py
"""

import importlib.util
import json
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


def inspect_result(state="running", health=None, returncode=0):
    """What `docker inspect --format '{{.State.Status}}|{{…Health…}}'` prints."""
    return subprocess.CompletedProcess(
        [], returncode, f"{state}|{health if health is not None else ''}\n", ""
    )


class CmdStatusTests(unittest.TestCase):
    def deployed_project(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        (Path(temp.name) / "deploy").mkdir()
        return temp.name

    def run_status(self, result, container_id="abc123"):
        payload = {"projectDir": self.deployed_project(), "projectType": "NODEJS"}
        with patch.object(
            docker_manager, "get_container_id", return_value=container_id
        ), patch.object(
            docker_manager, "get_docker_binary", return_value="docker"
        ), patch.object(
            docker_manager, "run_bounded", return_value=result
        ) as bounded, patch("builtins.print") as printer:
            docker_manager.cmd_status(payload)
            emitted = [
                json.loads(call.args[0])
                for call in printer.call_args_list
                if call.args and "log" not in call.args[0]
            ]
            return bounded, emitted[-1]

    def test_a_failing_healthcheck_is_reported_even_while_running(self):
        _, status = self.run_status(inspect_result(health="unhealthy"))
        self.assertEqual(status["containerStatus"], "running")
        self.assertEqual(status["containerHealth"], "unhealthy")

    def test_health_is_read_in_the_same_inspect_call_as_status(self):
        # Two calls would double the round trip on the panel's 5s poll.
        bounded, _ = self.run_status(inspect_result(health="healthy"))
        self.assertEqual(bounded.call_count, 1)
        cmd = bounded.call_args[0][1]
        fmt = cmd[cmd.index("--format") + 1]
        self.assertIn("{{.State.Status}}", fmt)
        self.assertIn(".State.Health", fmt)

    def test_a_container_that_is_up_and_probing_is_healthy(self):
        _, status = self.run_status(inspect_result(health="healthy"))
        self.assertEqual(status["containerHealth"], "healthy")

    def test_a_container_still_in_its_start_period_is_starting(self):
        _, status = self.run_status(inspect_result(health="starting"))
        self.assertEqual(status["containerHealth"], "starting")

    def test_an_image_with_no_healthcheck_reports_no_health_at_all(self):
        # Docker prints nothing between the separators when the image declares
        # no HEALTHCHECK. That is not the same as a probe that failed, so it
        # must not arrive as a string the dashboard could colour as unhealthy.
        _, status = self.run_status(inspect_result(health=None))
        self.assertEqual(status["containerStatus"], "running")
        self.assertIsNone(status["containerHealth"])

    def test_a_failed_inspect_is_unknown_rather_than_running(self):
        _, status = self.run_status(inspect_result(state="", health=None, returncode=1))
        self.assertEqual(status["containerStatus"], "unknown")
        self.assertIsNone(status["containerHealth"])

    def test_a_project_with_no_container_reports_not_found(self):
        _, status = self.run_status(inspect_result(), container_id=None)
        self.assertEqual(status["containerStatus"], "not_found")
        self.assertIsNone(status["containerHealth"])
        self.assertIsNone(status["containerId"])

    def test_an_undeployed_project_reports_not_found(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        with patch.object(docker_manager, "get_docker_binary", return_value="docker"), patch(
            "builtins.print"
        ) as printer:
            docker_manager.cmd_status(
                {"projectDir": temp.name, "projectType": "NODEJS"}
            )
            status = json.loads(printer.call_args.args[0])
        self.assertEqual(status["containerStatus"], "not_found")
        self.assertIsNone(status["containerHealth"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
