"""Installer output: no error-looking noise on a healthy first install (#133, #134, #135)."""

import shutil
import subprocess
import unittest
from pathlib import Path


STEPS = Path(__file__).resolve().parent.parent / "system" / "scripts" / "install" / "steps"


def read_step(name: str) -> str:
    return (STEPS / name).read_text(encoding="utf-8")


class InstallerOutputTest(unittest.TestCase):
    def test_locally_built_mail_images_are_built_before_services_start(self) -> None:
        images = read_step("10-images.sh")
        self.assertRegex(images, r"build dashboard api postfix dovecot")

    def test_corepack_download_prompt_is_disabled(self) -> None:
        runtime = read_step("04-runtime.sh")
        prompt = runtime.index("COREPACK_ENABLE_DOWNLOAD_PROMPT=0")
        self.assertLess(prompt, runtime.index("corepack prepare"))

    def test_summary_waits_for_certificates_before_warning(self) -> None:
        summary = read_step("16-summary.sh")
        wait = summary.index("until {")
        warning = summary.index("No Let's Encrypt certificate detected")
        self.assertLess(wait, warning)
        self.assertIn('traefik_has_certificate "api.${VEXLYX_DOMAIN}"', summary)

    def test_certificate_lookup_matches_the_acme_file_format(self) -> None:
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash is required")
        summary = read_step("16-summary.sh")
        start = summary.index("traefik_has_certificate() {")
        function = summary[start : summary.index("\n}\n", start) + 3]
        acme = '{"le":{"Certificates":[{"domain":{\n          "main": "panel.example.org"\n}}]}}'
        script = (
            'COMPOSE=(cat); ' + function
            + f"\nCOMPOSE=(printf '%s' '{acme}'); "
            'traefik_has_certificate() { "${COMPOSE[@]}" | grep -Eq "\\"main\\": ?\\"$1\\""; }\n'
            "traefik_has_certificate panel.example.org && echo found\n"
            "traefik_has_certificate api.example.org || echo missing\n"
        )
        result = subprocess.run([bash, "-c", script], capture_output=True, text=True, check=False)
        self.assertEqual(result.stdout.split(), ["found", "missing"], result.stderr)


if __name__ == "__main__":
    unittest.main()
