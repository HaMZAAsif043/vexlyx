"""
test_ssl_key_permissions.py — Regression tests for SSL key material (#195).

Certificates are written into `docker/traefik/certs` on the host. Private
keys must not be created world-readable, and the `<hostname>.crt/.key`
convenience copies must not survive deleting the certificate.
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "system" / "python" / "ssl_manager.py"

HOSTNAME = "app.example.com"


def run_manager(cmd: str, payload: dict, cwd: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), cmd, json.dumps(payload)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=cwd,
    )
    if proc.returncode != 0:
        raise AssertionError(f"ssl_manager failed: {proc.stderr}")
    return json.loads(proc.stdout.strip())


def certs_dir_for(cwd: Path) -> Path:
    return cwd / "docker" / "traefik" / "certs"


class SslKeyPermissionsTest(unittest.TestCase):
    def test_self_signed_writes_both_name_pairs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cwd = Path(tmpdir)
            result = run_manager(
                "generate_self_signed",
                {"hostname": HOSTNAME, "sans": [f"*.{HOSTNAME}"], "domainId": "dom1"},
                cwd,
            )
            self.assertTrue(result.get("success"), result)

            certs = certs_dir_for(cwd)
            for name in ("domain-dom1", HOSTNAME):
                self.assertTrue((certs / f"{name}.crt").is_file(), name)
                self.assertTrue((certs / f"{name}.key").is_file(), name)

    @unittest.skipUnless(os.name == "posix", "POSIX permission bits")
    def test_self_signed_key_is_private_and_directory_is_private(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cwd = Path(tmpdir)
            result = run_manager(
                "generate_self_signed",
                {"hostname": HOSTNAME, "sans": [f"*.{HOSTNAME}"], "domainId": "dom1"},
                cwd,
            )
            self.assertTrue(result.get("success"), result)

            certs = certs_dir_for(cwd)
            for name in ("domain-dom1", HOSTNAME):
                key_mode = stat.S_IMODE((certs / f"{name}.key").stat().st_mode)
                cert_mode = stat.S_IMODE((certs / f"{name}.crt").stat().st_mode)
                self.assertEqual(key_mode, 0o600, f"{name}.key mode")
                self.assertEqual(cert_mode, 0o644, f"{name}.crt mode")
            self.assertEqual(stat.S_IMODE(certs.stat().st_mode), 0o700)

    def test_delete_removes_convenience_copies(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cwd = Path(tmpdir)
            generated = run_manager(
                "generate_self_signed",
                {"hostname": HOSTNAME, "domainId": "dom1"},
                cwd,
            )
            self.assertTrue(generated.get("success"), generated)

            result = run_manager(
                "delete_cert", {"domainId": "dom1", "hostname": HOSTNAME}, cwd
            )
            self.assertTrue(result.get("success"), result)
            self.assertTrue(result.get("deleted"), result)

            certs = certs_dir_for(cwd)
            for suffix in (".crt", ".key"):
                for name in ("domain-dom1", HOSTNAME):
                    self.assertFalse((certs / f"{name}{suffix}").exists(), name)

    def test_custom_upload_replaces_the_convenience_copies(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cwd = Path(tmpdir)
            generated = run_manager(
                "generate_self_signed", {"hostname": HOSTNAME, "domainId": "old"}, cwd
            )
            self.assertTrue(generated.get("success"), generated)

            saved = run_manager(
                "save_custom",
                {
                    "domainId": "dom2",
                    "hostname": HOSTNAME,
                    "certificate": generated["certPem"],
                    "privateKey": generated["keyPem"],
                },
                cwd,
            )
            self.assertTrue(saved.get("success"), saved)

            certs = certs_dir_for(cwd)
            convenience_key = (certs / f"{HOSTNAME}.key").read_text(encoding="utf-8")
            self.assertEqual(convenience_key, generated["keyPem"].strip())
            if os.name == "posix":
                self.assertEqual(
                    stat.S_IMODE((certs / "domain-dom2.key").stat().st_mode), 0o600
                )


if __name__ == "__main__":
    unittest.main()
