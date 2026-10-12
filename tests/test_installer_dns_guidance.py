import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
SUMMARY = ROOT_DIR / "system" / "scripts" / "install" / "steps" / "16-summary.sh"


class TestInstallerDnsGuidance(unittest.TestCase):
    def run_summary(self, mail_hostname: str, mail_domain: str, public_ip: str) -> str:
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash is required to execute the installer summary")

        with tempfile.TemporaryDirectory() as temporary_directory:
            bin_dir = Path(temporary_directory)
            docker = bin_dir / "docker"
            docker.write_text("#!/usr/bin/env bash\necho '{\"Certificate\":true}'\n", encoding="utf-8")
            docker.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{bin_dir}{os.pathsep}{env.get('PATH', '')}",
                    "VEXLYX_DOMAIN": "panel.example.com",
                    "VEXLYX_BASE_DOMAIN": "apps.example.com",
                    "VEXLYX_ADMIN_EMAIL": "admin@example.com",
                    "VEXLYX_ADMIN_PASSWORD": "unused",
                    "VEXLYX_HOME": "/opt/vexlyx",
                    "VEXLYX_SECRETS_FILE": "/etc/vexlyx/vexlyx.env",
                    "VEXLYX_MAIL_HOSTNAME": mail_hostname,
                    "VEXLYX_MAIL_DOMAIN": mail_domain,
                    "VEXLYX_PUBLIC_IP": public_ip,
                    "ADMIN_PASSWORD_WAS_GENERATED": "false",
                }
            )
            command = f'log_step() {{ :; }}; log_warn() {{ :; }}; source "{SUMMARY.as_posix()}"'
            result = subprocess.run(
                [bash, "-c", command],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=env,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

    def test_default_mail_dns_records_include_server_ip(self):
        output = self.run_summary("mail.panel.example.com", "panel.example.com", "203.0.113.10")

        self.assertIn("A     mail.panel.example.com", output)
        self.assertIn("-> 203.0.113.10", output)
        self.assertIn("MX    panel.example.com", output)
        self.assertIn("-> mail.panel.example.com  (priority 10)", output)

    def test_custom_mail_hostname_and_domain_are_preserved(self):
        output = self.run_summary("mx1.mailhost.net", "example.org", "203.0.113.10")

        self.assertIn("A     mx1.mailhost.net", output)
        self.assertIn("MX    example.org", output)
        self.assertIn("-> mx1.mailhost.net  (priority 10)", output)

    def test_records_are_printed_when_public_ip_detection_failed(self):
        output = self.run_summary("mx1.mailhost.net", "example.org", "")

        self.assertIn("Inbound hosted mail also requires", output)
        self.assertIn("A     mx1.mailhost.net", output)
        self.assertIn("MX    example.org", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
