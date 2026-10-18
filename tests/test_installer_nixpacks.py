"""Nixpacks handling in the installer: no host install, checked in the API image."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
STEPS = ROOT_DIR / "system" / "scripts" / "install" / "steps"


class InstallerNixpacksTest(unittest.TestCase):
    def test_host_runtime_step_no_longer_installs_nixpacks(self) -> None:
        script = (STEPS / "04-runtime.sh").read_text(encoding="utf-8")
        self.assertNotIn("nixpacks.com/install.sh", script)
        self.assertNotIn("has_cmd nixpacks", script)

    def run_images_step(self, nixpacks_works: bool) -> subprocess.CompletedProcess:
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash is required to execute the installer step")

        with tempfile.TemporaryDirectory() as temporary_directory:
            bin_dir = Path(temporary_directory)
            log_file = bin_dir / "docker.log"
            docker = bin_dir / "docker"
            docker.write_text(
                "#!/usr/bin/env bash\n"
                f'echo "$@" >> "{log_file.as_posix()}"\n'
                'if [[ "$1" == "run" ]]; then\n'
                + ('  echo "nixpacks 1.41.0"\n' if nixpacks_works else '  echo "executable file not found"; exit 127\n')
                + "fi\n",
                encoding="utf-8",
            )
            docker.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{bin_dir.as_posix()}{os.pathsep}{env.get('PATH', '')}",
                    "VEXLYX_SECRETS_FILE": "/etc/vexlyx/vexlyx.env",
                }
            )
            command = (
                "log_step() { echo \"STEP $*\"; }; "
                "log_ok() { echo \"OK $*\"; }; "
                "log_warn() { echo \"WARN $*\"; }; "
                f'cd "{ROOT_DIR.as_posix()}"; '
                f'source "{(STEPS / "10-images.sh").as_posix()}"'
            )
            return subprocess.run([bash, "-c", command], capture_output=True, text=True, env=env)

    def test_reports_nixpacks_ready_when_the_api_image_has_it(self) -> None:
        result = self.run_images_step(nixpacks_works=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OK Nixpacks ready in the API image (nixpacks 1.41.0).", result.stdout)
        self.assertNotIn("WARN", result.stdout)

    def test_warns_clearly_when_the_api_image_lacks_nixpacks(self) -> None:
        result = self.run_images_step(nixpacks_works=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WARN Nixpacks is not available in the API image", result.stdout)
        self.assertIn("project builds will fail", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
