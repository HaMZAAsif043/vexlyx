"""Which paths the generated nginx configs serve.

No-build PHP and no-build static sites serve the whole project directory, so
panel-owned and dot files that sit in it must not be reachable over HTTP:
deploy/ (generated compose file and nginx config), .git, .env and friends.
/.well-known/ stays reachable (ACME challenges, security.txt, app links).

The live tests render each template, start a disposable nginx:alpine on a
random loopback port over a docroot that holds such files, and request them,
including encoded and dot-segment spellings. They are skipped without Docker.
"""

import http.client
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = REPO_ROOT / "system" / "templates" / "nginx"

BLOCKED = [
    "/deploy/docker-compose.yml",
    "/deploy/nginx.conf",
    "/deploy",
    "/deploy/",
    "/deploy/anything.php",
    "/.git/config",
    "/.git/HEAD",
    "/.env",
    "/.env.local",
    "/.htaccess",
    "/.htpasswd",
    "/sub/.env",
    "/sub/.git/config",
    "/%64eploy/docker-compose.yml",       # percent-encoded 'd'
    "/%2e%67it/config",                   # percent-encoded '.git'
    "/%2eenv",                            # percent-encoded '.env'
    "//deploy/docker-compose.yml",        # doubled slash
    "/./deploy/docker-compose.yml",       # dot segment
    "/sub/../deploy/docker-compose.yml",  # parent segment
    "/.well-known/../.env",               # traversal out of the allowed prefix
]
ALLOWED = {
    "/": 200,
    "/style.css": 200,
    "/app.js": 200,
    "/sub/page.html": 200,
    "/.well-known/acme-challenge/token": 200,
    "/.well-known/security.txt": 200,
    "/deployment-notes.txt": 200,   # only the exact deploy/ directory is private
    "/mydeploy/info.txt": 200,
}


def docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


class TemplateTextTest(unittest.TestCase):
    def test_both_templates_deny_deploy_and_dot_paths(self):
        for name in ("php.conf.template", "spa.conf.template"):
            text = (TEMPLATES / name).read_text(encoding="utf-8")
            self.assertIn("deploy", text, name)
            self.assertIn("well-known", text, name)
            self.assertIn("return 404", text, name)

    def test_the_deny_rules_come_before_the_php_handler(self):
        text = (TEMPLATES / "php.conf.template").read_text(encoding="utf-8")
        self.assertLess(text.index("/deploy"), text.index("fastcgi_pass"))


@unittest.skipUnless(docker_available(), "Docker is required")
class LiveServedPathsTest(unittest.TestCase):
    """One nginx per template, over a docroot laid out like a real project."""

    servers = {}

    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp(prefix="vexlyx-nginx-paths-"))
        cls.addClassCleanup(shutil.rmtree, cls.work, True)

        root = cls.work / "site"
        files = {
            "index.html": "home",
            "style.css": "body{}",
            "app.js": "1",
            "sub/page.html": "page",
            "sub/.env": "SECRET=1",
            "sub/.git/config": "[core]",
            ".env": "SECRET=1",
            ".env.local": "SECRET=1",
            ".htaccess": "x",
            ".htpasswd": "x",
            ".git/config": "[core]",
            ".git/HEAD": "ref: refs/heads/main",
            ".well-known/acme-challenge/token": "challenge",
            ".well-known/security.txt": "Contact: x",
            "deploy/docker-compose.yml": "environment: SECRET",
            "deploy/nginx.conf": "server {}",
            "deployment-notes.txt": "notes",
            "mydeploy/info.txt": "info",
        }
        for relative, content in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        root.chmod(0o755)
        for path in root.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)

        for name, upstream_host in (("php", "phpfpm.test"), ("spa", None)):
            rendered = (TEMPLATES / f"{name}.conf.template").read_text(encoding="utf-8")
            rendered = rendered.replace("{{app_upstream}}", upstream_host or "unused")
            conf = cls.work / f"{name}.conf"
            conf.write_text(rendered, encoding="utf-8", newline="\n")
            container = f"vexlyx-paths-{name}-{uuid.uuid4().hex[:8]}"
            docroot = "/var/www/html" if name == "php" else "/usr/share/nginx/html"
            run = subprocess.run(
                [
                    "docker", "run", "-d", "--rm", "--name", container,
                    "-p", "127.0.0.1::80",
                    "--add-host", "phpfpm.test:127.0.0.1",
                    "-v", f"{root.as_posix()}:{docroot}:ro",
                    "-v", f"{conf.as_posix()}:/etc/nginx/conf.d/default.conf:ro",
                    "nginx:alpine",
                ],
                capture_output=True, text=True,
            )
            if run.returncode != 0:
                raise unittest.SkipTest(f"could not start nginx: {run.stderr[-300:]}")
            cls.addClassCleanup(subprocess.run, ["docker", "rm", "-f", container], capture_output=True)
            port = subprocess.run(
                ["docker", "port", container, "80/tcp"], capture_output=True, text=True
            ).stdout.strip().splitlines()[0].rsplit(":", 1)[1]
            cls.servers[name] = int(port)
            cls._wait_until_serving(int(port), container)

    @classmethod
    def _wait_until_serving(cls, port, container):
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                if cls.status(port, "/style.css") == 200:
                    return
            except OSError:
                pass
            time.sleep(0.5)
        logs = subprocess.run(["docker", "logs", container], capture_output=True, text=True)
        raise AssertionError(f"nginx never served /style.css:\n{logs.stdout}{logs.stderr}")

    @staticmethod
    def status(port, path):
        # http.client sends the request target exactly as given (no normalising).
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request("GET", path, headers={"Host": "site.test"})
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    def check_blocked(self, name):
        port = self.servers[name]
        for path in BLOCKED:
            with self.subTest(template=name, path=path):
                self.assertEqual(self.status(port, path), 404)

    def check_allowed(self, name):
        port = self.servers[name]
        for path, expected in ALLOWED.items():
            if name == "php" and path == "/":
                continue  # the front controller needs a PHP-FPM behind it
            with self.subTest(template=name, path=path):
                self.assertEqual(self.status(port, path), expected)

    def test_php_blocks_private_paths(self):
        self.check_blocked("php")

    def test_php_still_serves_public_paths(self):
        self.check_allowed("php")

    def test_spa_blocks_private_paths(self):
        self.check_blocked("spa")

    def test_spa_still_serves_public_paths(self):
        self.check_allowed("spa")


if __name__ == "__main__":
    unittest.main()
