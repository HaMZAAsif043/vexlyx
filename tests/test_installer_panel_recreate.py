"""The installer recreates the panel containers after every run.

The API and dashboard run the build that installer step 09 writes to the host
and bind-mounts. `docker compose up -d` only recreates a container whose
configuration changed, so an upgrade that changes only code or the env file
used to leave the previous API process running (found rehearsing v0.4.1-rc.1
to rc.2: the new build was on disk, the old process still served requests).
"""

import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
STEP = ROOT_DIR / "system" / "scripts" / "install" / "steps" / "14-services-up.sh"


class PanelRecreateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.lines = STEP.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")

    def index_of(self, needle: str) -> int:
        for position, line in enumerate(self.lines):
            if needle in line and not line.lstrip().startswith("#"):
                return position
        self.fail(f"{needle!r} not found in {STEP.name}")

    def test_api_and_dashboard_are_force_recreated(self) -> None:
        line = self.lines[self.index_of("--force-recreate")]
        self.assertIn("--no-deps", line)  # never drags the databases along
        self.assertTrue(line.rstrip().endswith("api dashboard"), line)

    def test_recreate_happens_after_the_stack_is_up_and_before_the_health_wait(self) -> None:
        stack_up = self.index_of("up -d --wait --wait-timeout 120")
        recreate = self.index_of("--force-recreate")
        health_wait = self.index_of("Waiting for the panel API to respond")
        self.assertLess(stack_up, recreate)
        self.assertLess(recreate, health_wait)

    def test_databases_and_mail_are_not_force_recreated(self) -> None:
        recreating = [line for line in self.lines if "--force-recreate" in line and not line.lstrip().startswith("#")]
        self.assertEqual(len(recreating), 1)
        for service in ("postgres", "mysql", "redis", "postfix", "dovecot", "traefik"):
            self.assertNotIn(service, recreating[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
