"""
Docker project port auto-wiring (#152).

A repo-sourced Dockerfile's EXPOSE was never read: only Dockerfiles saved
through the dashboard editor persisted a port (syncPort), so a Docker project
cloned from git deployed with the DOCKER default of 3000 even when its image
clearly served on port 80 — Traefik then returned 502.

cmd_deploy now resolves the container port through resolve_container_port():
explicit override > repo Dockerfile's first EXPOSEd port (DOCKER only) >
per-type default.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "docker_manager", Path(__file__).parents[1] / "system/python/docker_manager.py"
)
docker_manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(docker_manager)


def project_dir_with(dockerfile: str | None) -> str:
    temp = tempfile.TemporaryDirectory()
    # Caller owns cleanup via the test's own TemporaryDirectory when needed;
    # these helpers are used inside tests that clean up at process exit or
    # deliberately keep the dir for the duration of the test.
    if dockerfile is not None:
        (Path(temp.name) / "Dockerfile").write_text(dockerfile, encoding="utf-8")
    return temp.name


class FirstExposedPortTests(unittest.TestCase):
    def make_dir(self, dockerfile: str | None) -> str:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        if dockerfile is not None:
            (Path(temp.name) / "Dockerfile").write_text(dockerfile, encoding="utf-8")
        return temp.name

    def test_reads_first_exposed_port_from_repo_dockerfile(self):
        # The exact #152 repro: a WordPress apache image with EXPOSE 80.
        d = self.make_dir(
            "FROM wordpress:php8.3-apache\nEXPOSE 80\nCMD [\"apache2-foreground\"]\n"
        )
        self.assertEqual(docker_manager.first_exposed_port(d), 80)

    def test_first_of_multiple_ports_wins(self):
        d = self.make_dir("FROM x\nEXPOSE 8080 9000/tcp\n")
        self.assertEqual(docker_manager.first_exposed_port(d), 8080)

    def test_protocol_suffixes_and_lowercase_are_accepted(self):
        d = self.make_dir("FROM x\nexpose 443/tcp\n")
        self.assertEqual(docker_manager.first_exposed_port(d), 443)

    def test_ignores_commented_and_non_numeric_expose(self):
        d = self.make_dir("FROM x\n# EXPOSE 9999\nEXPOSE abc\n")
        self.assertIsNone(docker_manager.first_exposed_port(d))

    def test_missing_dockerfile_returns_none(self):
        d = self.make_dir(None)
        self.assertIsNone(docker_manager.first_exposed_port(d))

    def test_dockerfile_without_expose_returns_none(self):
        d = self.make_dir("FROM x\nCMD [\"true\"]\n")
        self.assertIsNone(docker_manager.first_exposed_port(d))


class ResolveContainerPortTests(unittest.TestCase):
    def make_dir(self, dockerfile: str | None) -> str:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        if dockerfile is not None:
            (Path(temp.name) / "Dockerfile").write_text(dockerfile, encoding="utf-8")
        return temp.name

    def test_docker_project_honors_repo_expose_when_port_unset(self):
        # The #152 regression: port was null → 3000 → 502. Now EXPOSE 80 wins.
        d = self.make_dir("FROM wordpress:php8.3-apache\nEXPOSE 80\n")
        self.assertEqual(
            docker_manager.resolve_container_port({}, "DOCKER", d), 80
        )

    def test_explicit_override_beats_expose(self):
        d = self.make_dir("FROM x\nEXPOSE 80\n")
        self.assertEqual(
            docker_manager.resolve_container_port({"containerPort": 9000}, "DOCKER", d),
            9000,
        )

    def test_docker_without_dockerfile_keeps_default(self):
        d = self.make_dir(None)
        self.assertEqual(
            docker_manager.resolve_container_port({}, "DOCKER", d), 3000
        )

    def test_docker_with_exposeless_dockerfile_keeps_default(self):
        d = self.make_dir("FROM x\nCMD [\"true\"]\n")
        self.assertEqual(
            docker_manager.resolve_container_port({}, "DOCKER", d), 3000
        )

    def test_non_docker_types_keep_runtime_defaults(self):
        # Other types deploy panel-managed runtime images, so a repo
        # Dockerfile must not influence their port.
        d = self.make_dir("FROM x\nEXPOSE 80\n")
        self.assertEqual(docker_manager.resolve_container_port({}, "NODEJS", d), 3000)
        self.assertEqual(docker_manager.resolve_container_port({}, "PYTHON", d), 8000)
        self.assertEqual(docker_manager.resolve_container_port({}, "STATIC", d), 80)


class CmdDeployWiringTests(unittest.TestCase):
    """cmd_deploy must feed the resolved port into the generated compose file."""

    def test_deploy_generates_compose_with_expose_port(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        (Path(temp.name) / "Dockerfile").write_text(
            "FROM wordpress:php8.3-apache\nEXPOSE 80\n", encoding="utf-8"
        )

        captured = {}

        def fake_generate_compose_file(**kwargs):
            captured.update(kwargs)

        with (
            patch.object(docker_manager, "get_docker_binary", return_value="docker"),
            patch.object(docker_manager, "ensure_traefik_network"),
            patch.object(docker_manager, "derive_host_port", return_value=8100),
            patch.object(
                docker_manager, "generate_compose_file", side_effect=fake_generate_compose_file
            ),
            patch.object(docker_manager, "run_compose"),
            patch.object(docker_manager, "get_container_id", return_value="abc123def456"),
            patch("builtins.print") as printed,
        ):
            docker_manager.cmd_deploy(
                {
                    "projectId": "p1",
                    "projectName": "My WordPress Site",
                    "projectDir": temp.name,
                    "imageName": "vexlyx-p1",
                    "projectType": "DOCKER",
                    "baseDomain": "vexlyx.localhost",
                    "memoryLimit": "128m",
                    "portRangeStart": 8100,
                    "portRangeEnd": 8999,
                }
            )

        # The compose file Traefik consumes must target EXPOSE's 80, not 3000.
        self.assertEqual(captured.get("container_port"), 80)
        self.assertEqual(captured.get("host_port"), 8100)

        # And the command must still respond with the standard JSON envelope.
        emitted = [json.loads(c.args[0]) for c in printed.call_args_list if c.args]
        final = emitted[-1]
        self.assertTrue(final.get("done"))
        self.assertEqual(final.get("hostPort"), 8100)


if __name__ == "__main__":
    unittest.main()
