"""Project containers are isolated from the panel's own services.

Two external Docker networks split the stack:

  traefik-net  panel-internal: Redis, the API, the panel database, mail, DNS
  vexlyx-apps  project containers, Traefik, and the database servers that
               customer databases live on

These tests pin that layout in the compose files and project templates, cover
how docker_manager.py creates the apps network and moves an already-deployed
project onto it, and check that Redis requires a password everywhere it runs.
"""

import importlib.util
import io
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "system" / "templates" / "docker-compose"
APPS = "vexlyx-apps"
PANEL = "traefik-net"

spec = importlib.util.spec_from_file_location("docker_manager_network", ROOT / "system" / "python" / "docker_manager.py")
dm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dm)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def service_networks(compose_text: str) -> dict[str, list[str]]:
    """Service name -> networks listed under it, for the services: section."""
    result: dict[str, list[str]] = {}
    in_services = False
    service = None
    in_networks = False
    for line in compose_text.split("\n"):
        if re.match(r"^\S", line):
            in_services = line.startswith("services:")
            service, in_networks = None, False
            continue
        if not in_services:
            continue
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if match:
            service, in_networks = match.group(1), False
            result.setdefault(service, [])
            continue
        if service is None:
            continue
        if re.match(r"^    networks:\s*(!override|!reset)?\s*(\[.*\])?\s*$", line):
            in_networks = True
            inline = re.search(r"\[(.*)\]", line)
            if inline:
                result[service] += [name.strip() for name in inline.group(1).split(",") if name.strip()]
            continue
        if in_networks:
            item = re.match(r"^      - ([A-Za-z0-9_-]+)\s*$", line)
            if item:
                result[service].append(item.group(1))
                continue
            if re.match(r"^      #", line):
                continue
            in_networks = False
    return result


def declared_networks(compose_text: str) -> dict[str, str]:
    """Top-level networks: key -> the external network name it points at."""
    block = compose_text.split("\nnetworks:\n", 1)[1] if "\nnetworks:\n" in compose_text else ""
    result: dict[str, str] = {}
    current = None
    for line in block.split("\n"):
        if re.match(r"^\S", line):
            break
        key = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if key:
            current = key.group(1)
            result[current] = current
            continue
        named = re.match(r"^    name:\s*[\"']?([A-Za-z0-9_-]+)", line)
        if named and current:
            result[current] = named.group(1)
    return result


class ProjectTemplatesTest(unittest.TestCase):
    templates = sorted(TEMPLATES.glob("*.yml"))

    def test_there_are_templates_to_check(self) -> None:
        self.assertGreaterEqual(len(self.templates), 8)

    def test_every_template_joins_only_the_apps_network(self) -> None:
        for template in self.templates:
            with self.subTest(template=template.name):
                text = read(template)
                self.assertEqual(declared_networks(text), {"default": APPS})
                for service, networks in service_networks(text).items():
                    self.assertTrue(set(networks) <= {"default"}, f"{service} joins {networks}")

    def test_no_template_mentions_the_panel_network(self) -> None:
        for template in self.templates:
            with self.subTest(template=template.name):
                self.assertNotIn(PANEL, read(template))

    def test_no_template_reaches_around_the_network_split(self) -> None:
        for template in self.templates:
            with self.subTest(template=template.name):
                text = read(template)
                self.assertNotRegex(text, r"network_mode:")
                self.assertNotIn("/var/run/docker.sock", text)

    def test_a_generated_compose_file_lands_on_the_apps_network(self) -> None:
        for template in self.templates:
            with self.subTest(template=template.name), tempfile.TemporaryDirectory() as tmp:
                dm.generate_compose_file(
                    compose_dir=Path(tmp),
                    template_path=template,
                    image_name="example:latest",
                    service_name="abc123",
                    hostname="app.example.test",
                    host_port=8100,
                    container_port=3000,
                    memory_limit="512m",
                    env_vars={},
                    extra_placeholders={
                        "deploy_dir": tmp, "static_root": tmp, "php_root": tmp,
                        "nginx_conf_path": tmp + "/nginx.conf", "php_fpm_image": "php:8",
                        "wp_db_host": "h", "wp_db_name": "n", "wp_db_user": "u",
                        "wp_db_password": "p", "wp_db_prefix": "wp_",
                    },
                )
                generated = read(Path(tmp) / "docker-compose.yml")
                self.assertIn(f"name: {APPS}", generated)
                self.assertNotIn(PANEL, generated)


class StackNetworksTest(unittest.TestCase):
    base = read(ROOT / "docker-compose.yml")
    prod = read(ROOT / "docker-compose.prod.yml")

    def test_both_networks_are_declared_external(self) -> None:
        declared = declared_networks(self.base)
        self.assertEqual(declared[PANEL], PANEL)
        self.assertEqual(declared[APPS], APPS)
        self.assertEqual(len(re.findall(r"^    external: true", self.base.split("\nnetworks:\n")[1], re.M)), 2)

    def test_only_traefik_and_the_database_servers_join_the_apps_network(self) -> None:
        joined = {name for name, nets in service_networks(self.base).items() if APPS in nets}
        self.assertEqual(joined, {"traefik", "postgres", "mysql"})

    def test_the_production_overlay_adds_nothing_to_the_apps_network(self) -> None:
        joined = {name for name, nets in service_networks(self.prod).items() if APPS in nets}
        self.assertEqual(joined, set())

    def test_panel_services_stay_off_the_apps_network(self) -> None:
        networks = service_networks(self.base)
        networks.update({k: v for k, v in service_networks(self.prod).items() if v})
        for service in ("redis", "dashboard", "api", "dovecot", "coredns", "postfix", "roundcube", "adminer"):
            with self.subTest(service=service):
                self.assertNotIn(APPS, networks.get(service, []))
                self.assertIn(PANEL, networks.get(service, []))

    def test_traefik_reaches_both_networks(self) -> None:
        self.assertTrue({PANEL, APPS} <= set(service_networks(self.base)["traefik"]))


class RedisPasswordTest(unittest.TestCase):
    base = read(ROOT / "docker-compose.yml")
    prod = read(ROOT / "docker-compose.prod.yml")

    def test_redis_starts_with_a_password(self) -> None:
        redis = self.base.split("\n  redis:\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn('--requirepass "$$REDIS_PASSWORD"', redis)

    def test_the_development_default_is_not_empty(self) -> None:
        self.assertIn("REDIS_PASSWORD: ${REDIS_PASSWORD:-vexlyx_dev}", self.base)

    def test_production_refuses_to_start_without_a_password(self) -> None:
        self.assertIn("REDIS_PASSWORD: ${REDIS_PASSWORD:?", self.prod)

    def test_the_api_url_carries_the_password(self) -> None:
        url = re.search(r"^\s+REDIS_URL: .*$", self.prod, re.M)
        self.assertIsNotNone(url)
        self.assertRegex(url.group(0), r"redis://:\$\{REDIS_PASSWORD:\?[^}]+\}@redis:6379$")

    def test_the_healthcheck_authenticates(self) -> None:
        redis = self.base.split("\n  redis:\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn("REDISCLI_AUTH", redis)
        self.assertIn("grep -q PONG", redis)

    def test_the_example_env_file_has_a_password(self) -> None:
        example = read(ROOT / "apps" / "api" / ".env.example")
        self.assertRegex(example, r"(?m)^REDIS_URL=redis://:[^@\s]+@")


class AppsNetworkCreationTest(unittest.TestCase):
    def run_ensure(self, inspect_returncode: int) -> list[list[str]]:
        calls: list[list[str]] = []

        def fake_run_bounded(_timeout, command, **_kwargs):
            calls.append(command)
            returncode = inspect_returncode if command[1:3] == ["network", "inspect"] else 0
            return SimpleNamespace(returncode=returncode, stdout="", stderr="")

        with mock.patch.object(dm, "run_bounded", fake_run_bounded), redirect_stdout(io.StringIO()):
            dm.ensure_apps_network("docker")
        return calls

    def test_it_creates_the_network_when_missing(self) -> None:
        calls = self.run_ensure(inspect_returncode=1)
        self.assertEqual(calls[0], ["docker", "network", "inspect", APPS])
        self.assertEqual(calls[1], ["docker", "network", "create", APPS])

    def test_it_leaves_an_existing_network_alone(self) -> None:
        calls = self.run_ensure(inspect_returncode=0)
        self.assertEqual(calls, [["docker", "network", "inspect", APPS]])

    def test_deploy_ensures_the_apps_network_never_the_panel_one(self) -> None:
        source = read(ROOT / "system" / "python" / "docker_manager.py")
        deploy = source.split("def cmd_deploy", 1)[1].split("\ndef cmd_start", 1)[0]
        self.assertIn("ensure_apps_network(docker_bin)", deploy)
        self.assertNotIn(PANEL, deploy.replace("shared external vexlyx-apps", ""))


COMPOSE_BEFORE = (
    'name: "vexlyx-abc"\n\nservices:\n  app:\n    image: "x"\n\n'
    "networks:\n  default:\n    external: true\n    name: traefik-net\n"
)


class ComposeRewriteTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.file = Path(self._tmp.name) / "docker-compose.yml"

    def test_only_the_network_name_changes(self) -> None:
        self.file.write_text(COMPOSE_BEFORE, encoding="utf-8")
        self.assertTrue(dm.rewrite_compose_network(self.file))
        self.assertEqual(self.file.read_text(encoding="utf-8"), COMPOSE_BEFORE.replace(PANEL, APPS))

    def test_a_second_run_changes_nothing(self) -> None:
        self.file.write_text(COMPOSE_BEFORE, encoding="utf-8")
        dm.rewrite_compose_network(self.file)
        before = self.file.read_bytes()
        self.assertFalse(dm.rewrite_compose_network(self.file))
        self.assertEqual(self.file.read_bytes(), before)

    def test_quoted_names_and_windows_line_endings_survive(self) -> None:
        text = COMPOSE_BEFORE.replace("name: traefik-net", 'name: "traefik-net"').replace("\n", "\r\n")
        self.file.write_bytes(text.encode("utf-8"))
        self.assertTrue(dm.rewrite_compose_network(self.file))
        self.assertEqual(self.file.read_bytes(), text.replace(PANEL, APPS).encode("utf-8"))

    def test_other_mentions_of_the_panel_network_are_not_touched(self) -> None:
        text = COMPOSE_BEFORE + "# comment about traefik-net\n"
        self.file.write_text(text, encoding="utf-8")
        dm.rewrite_compose_network(self.file)
        self.assertIn("# comment about traefik-net", self.file.read_text(encoding="utf-8"))


class MoveContainerTest(unittest.TestCase):
    CID = "0123456789abcdef"

    def move(self, networks: dict, fail_on: str | None = None):
        calls: list[list[str]] = []

        def fake_run_bounded(_timeout, command, **_kwargs):
            calls.append(command)
            if command[1] == "inspect":
                return SimpleNamespace(returncode=0, stdout=json.dumps(networks), stderr="")
            if fail_on and command[2] == fail_on:
                return SimpleNamespace(returncode=1, stdout="", stderr="boom")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with mock.patch.object(dm, "run_bounded", fake_run_bounded), redirect_stdout(io.StringIO()):
            try:
                outcome = dm.move_container_to_apps_network("docker", self.CID)
            except SystemExit:
                outcome = "failed"
        return outcome, [c for c in calls if c[1] == "network"]

    def test_it_connects_with_the_old_aliases_then_disconnects(self) -> None:
        outcome, calls = self.move({PANEL: {"Aliases": ["app", self.CID[:12]]}})
        self.assertEqual(outcome, "moved")
        self.assertEqual(calls[0], ["docker", "network", "connect", "--alias", "app", APPS, self.CID])
        self.assertEqual(calls[1], ["docker", "network", "disconnect", PANEL, self.CID])

    def test_a_container_already_moved_is_left_alone(self) -> None:
        outcome, calls = self.move({APPS: {"Aliases": ["app"]}})
        self.assertEqual(outcome, "unchanged")
        self.assertEqual(calls, [])

    def test_a_half_moved_container_is_only_disconnected(self) -> None:
        outcome, calls = self.move({PANEL: {"Aliases": ["app"]}, APPS: {"Aliases": ["app"]}})
        self.assertEqual(outcome, "moved")
        self.assertEqual([c[2] for c in calls], ["disconnect"])

    def test_a_failed_connect_never_disconnects_the_old_network(self) -> None:
        outcome, calls = self.move({PANEL: {"Aliases": ["app"]}}, fail_on="connect")
        self.assertEqual(outcome, "failed")
        self.assertEqual([c[2] for c in calls], ["connect"])


class MigrateNetworkCommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name) / "p"
        (self.project / "deploy").mkdir(parents=True)

    def migrate(self, containers: list[tuple[str, str]]) -> tuple[dict, list[str]]:
        moved: list[str] = []

        def fake_move(_docker, container_id):
            moved.append(container_id)
            return "moved"

        out = io.StringIO()
        with mock.patch.object(dm, "get_docker_binary", return_value="docker"), \
             mock.patch.object(dm, "ensure_apps_network"), \
             mock.patch.object(dm, "list_project_containers", return_value=containers), \
             mock.patch.object(dm, "move_container_to_apps_network", fake_move), \
             mock.patch.object(dm, "reload_running_web_containers", return_value=0), \
             redirect_stdout(out):
            dm.cmd_migrate_network({"projectId": "cmvabcdef012345678", "projectDir": str(self.project)})
        result = json.loads(out.getvalue().strip().splitlines()[-1])
        return result, moved

    def test_stopped_containers_are_moved_too_and_not_started(self) -> None:
        (self.project / "deploy" / "docker-compose.yml").write_text(COMPOSE_BEFORE, encoding="utf-8")
        result, moved = self.migrate([("c1", "running"), ("c2", "exited")])
        self.assertEqual(moved, ["c1", "c2"])
        self.assertEqual(result["containersMoved"], 2)
        self.assertTrue(result["composeRewritten"])

    def test_a_project_without_a_compose_file_is_still_handled(self) -> None:
        result, moved = self.migrate([("c1", "running")])
        self.assertEqual(moved, ["c1"])
        self.assertFalse(result["composeRewritten"])

    def test_the_action_is_registered(self) -> None:
        self.assertIs(dm.COMMANDS["migrate_network"], dm.cmd_migrate_network)


class WebReloadAfterMoveTest(unittest.TestCase):
    """nginx resolves its php-fpm upstream once, so it must reload after the app moves."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name) / "p"
        (self.project / "deploy").mkdir(parents=True)

    def migrate(self, containers: dict, exec_fails: bool = False, restart_fails: bool = False):
        """containers: id -> (state, compose service). Returns (result or None, output lines, events)."""
        events: list[str] = []

        def fake_move(_docker, container_id):
            events.append(f"move:{container_id}")
            return "moved"

        def fake_run_bounded(_timeout, command, **_kwargs):
            if command[1] == "inspect":
                return SimpleNamespace(returncode=0, stdout=containers[command[-1]][1] + "\n", stderr="")
            if command[1] == "exec":
                events.append(f"reload:{command[2]}")
                return SimpleNamespace(returncode=1 if exec_fails else 0, stdout="", stderr="no nginx")
            if command[1] == "restart":
                events.append(f"restart:{command[2]}")
                return SimpleNamespace(returncode=1 if restart_fails else 0, stdout="", stderr="no docker")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        listed = [(cid, state) for cid, (state, _service) in containers.items()]
        out = io.StringIO()
        with mock.patch.object(dm, "get_docker_binary", return_value="docker"), \
             mock.patch.object(dm, "ensure_apps_network"), \
             mock.patch.object(dm, "list_project_containers", return_value=listed), \
             mock.patch.object(dm, "move_container_to_apps_network", fake_move), \
             mock.patch.object(dm, "run_bounded", fake_run_bounded), \
             redirect_stdout(out):
            try:
                dm.cmd_migrate_network({"projectId": "cmvabcdef012345678", "projectDir": str(self.project)})
            except SystemExit:
                pass
        lines = [json.loads(line) for line in out.getvalue().strip().splitlines() if line.strip()]
        result = lines[-1] if lines and lines[-1].get("done") else None
        return result, lines, events

    def test_a_web_and_app_project_gets_exactly_one_reload_after_both_moved(self) -> None:
        result, _lines, events = self.migrate({"app1": ("running", "app"), "web1": ("running", "web")})
        self.assertEqual(events, ["move:app1", "move:web1", "reload:web1"])
        self.assertEqual(result["webReloaded"], 1)

    def test_a_stopped_web_container_is_left_alone(self) -> None:
        result, _lines, events = self.migrate({"app1": ("exited", "app"), "web1": ("exited", "web")})
        self.assertFalse([e for e in events if e.startswith(("reload", "restart"))])
        self.assertEqual(result["webReloaded"], 0)

    def test_a_project_without_a_web_service_is_not_reloaded(self) -> None:
        result, _lines, events = self.migrate({"app1": ("running", "app")})
        self.assertEqual(events, ["move:app1"])
        self.assertEqual(result["webReloaded"], 0)

    def test_a_failed_reload_falls_back_to_a_restart(self) -> None:
        result, _lines, events = self.migrate({"web1": ("running", "web")}, exec_fails=True)
        self.assertEqual(events, ["move:web1", "reload:web1", "restart:web1"])
        self.assertEqual(result["webReloaded"], 1)

    def test_a_reload_and_restart_failure_fails_the_project_so_it_is_retried(self) -> None:
        result, lines, _events = self.migrate({"web1": ("running", "web")}, exec_fails=True, restart_fails=True)
        self.assertIsNone(result)
        self.assertEqual(lines[-1]["code"], "WEB_RELOAD_FAILED")

    def test_a_retry_reloads_even_though_nothing_moves_any_more(self) -> None:
        events_seen = self.migrate({"web1": ("running", "web")})[2]
        self.assertIn("reload:web1", events_seen)

    def test_deploy_does_not_reload_nginx(self) -> None:
        source = read(ROOT / "system" / "python" / "docker_manager.py")
        deploy = source.split("def cmd_deploy", 1)[1].split("\ndef cmd_start", 1)[0]
        self.assertNotIn("reload_running_web_containers", deploy)


def working_bash() -> str | None:
    """A bash that actually runs (Windows can resolve to a WSL stub that cannot)."""
    bash = shutil.which("bash")
    if not bash:
        return None
    try:
        probe = subprocess.run([bash, "-c", "echo ok"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return bash if probe.returncode == 0 and probe.stdout.strip() == "ok" else None


class RedisPasswordGenerationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bash = working_bash()
        if not self.bash:
            self.skipTest("a working bash is required")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        # A directory the installer creates itself: `install -d` cannot chmod an existing one on Windows.
        self.secrets = Path(self._tmp.name) / "etc-vexlyx" / "vexlyx.env"

    def run_generate(self, env_preset: str = "") -> subprocess.CompletedProcess:
        install = (ROOT / "system" / "scripts" / "install").as_posix()
        script = (
            f'source "{install}/lib.sh"; source "{install}/config.sh"; '
            f'VEXLYX_SECRETS_FILE="{self.secrets.as_posix()}"; VEXLYX_SECRETS_DIR="$(dirname "$VEXLYX_SECRETS_FILE")"; '
            f"{env_preset} generate_secrets"
        )
        env = {"PATH": __import__("os").environ["PATH"], "VEXLYX_DOMAIN": "panel.example.test",
               "VEXLYX_BASE_DOMAIN": "panel.example.test", "VEXLYX_ADMIN_EMAIL": "a@example.test",
               "VEXLYX_MAIL_HOSTNAME": "mail.example.test", "VEXLYX_MAIL_DOMAIN": "example.test",
               "VEXLYX_MAIL_STATE_DIR": "/var/lib/vexlyx/mail"}
        return subprocess.run([self.bash, "-c", script], capture_output=True, text=True, env=env)

    def password(self) -> str:
        match = re.search(r"(?m)^REDIS_PASSWORD=(.*)$", self.secrets.read_text(encoding="utf-8"))
        self.assertIsNotNone(match, "REDIS_PASSWORD missing from the secrets file")
        return match.group(1).strip()

    def test_a_fresh_install_gets_a_strong_password(self) -> None:
        result = self.run_generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(self.password(), r"^[0-9a-f]{64}$")

    def test_an_upgrade_without_one_gets_it_added_and_nothing_else_changes(self) -> None:
        self.secrets.parent.mkdir(parents=True)
        self.secrets.write_text("SESSION_SECRET=keep\nPOSTGRES_PASSWORD=keep2\nVEXLYX_MAIL_STATE_DIR=/x\n", encoding="utf-8")
        result = self.run_generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.secrets.read_text(encoding="utf-8")
        self.assertIn("SESSION_SECRET=keep\n", text)
        self.assertIn("POSTGRES_PASSWORD=keep2\n", text)
        self.assertRegex(self.password(), r"^[0-9a-f]{64}$")

    def test_an_existing_password_is_never_regenerated(self) -> None:
        self.run_generate()
        first = self.password()
        for _ in range(3):
            self.assertEqual(self.run_generate().returncode, 0)
        self.assertEqual(self.password(), first)

    def test_an_empty_password_line_is_replaced_not_kept(self) -> None:
        self.secrets.parent.mkdir(parents=True)
        self.secrets.write_text("SESSION_SECRET=keep\nREDIS_PASSWORD=\nVEXLYX_MAIL_STATE_DIR=/x\n", encoding="utf-8")
        self.assertEqual(self.run_generate().returncode, 0)
        self.assertRegex(self.password(), r"^[0-9a-f]{64}$")
        self.assertEqual(len(re.findall(r"(?m)^REDIS_PASSWORD=", self.secrets.read_text(encoding="utf-8"))), 1)


class InstallerStepsTest(unittest.TestCase):
    steps = ROOT / "system" / "scripts" / "install" / "steps"

    def test_the_network_step_creates_both_networks(self) -> None:
        text = read(self.steps / "08-network.sh")
        self.assertIn("for network in traefik-net vexlyx-apps", text)

    def test_redis_is_verified_to_refuse_unauthenticated_clients(self) -> None:
        text = read(self.steps / "11-infra-up.sh")
        self.assertIn("redis-cli ping", text)
        self.assertIn("--force-recreate --no-deps redis", text)
        self.assertIn("still accepts unauthenticated connections after being recreated", text)

    def test_projects_are_migrated_after_the_stack_is_up(self) -> None:
        lines = read(self.steps / "14-services-up.sh").split("\n")
        code = [(i, line) for i, line in enumerate(lines) if not line.lstrip().startswith("#")]
        stack_up = next(i for i, line in code if "up -d --wait --wait-timeout 120" in line and "force-recreate" not in line)
        migrate = next(i for i, line in code if "migrate-project-network.js" in line)
        self.assertLess(stack_up, migrate)


if __name__ == "__main__":
    unittest.main(verbosity=2)
