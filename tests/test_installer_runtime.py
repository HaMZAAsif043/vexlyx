"""Installer hardening (#72): pinned NodeSource key and a password that never reaches the log."""

import os
import select
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

try:  # POSIX only; the terminal tests are skipped where it is missing
    import pty
except ImportError:  # pragma: no cover
    pty = None


ROOT_DIR = Path(__file__).resolve().parent.parent
INSTALL_DIR = ROOT_DIR / "system" / "scripts" / "install"
STEPS = INSTALL_DIR / "steps"

PINNED = "6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
OTHER = "0000000000000000000000000000000000000000"
PASSWORD = "s3cret-generated-admin-pw"
POSIX = os.name == "posix"


def posix(path: Path) -> str:
    return path.as_posix()


def native_posix(path: Path) -> str:
    """Path form for a POSIX-flavoured tool started from Python. Git for
    Windows' gpg (MSYS) reads C:/x as a relative path and needs /c/x."""
    text = path.as_posix()
    if os.name == "nt" and len(text) > 2 and text[1] == ":":
        return f"/{text[0].lower()}{text[2:]}"
    return text


class InstallerRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bash = shutil.which("bash")
        if not self.bash:
            self.skipTest("bash is required to execute the installer steps")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()

    def stub(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8")
        path.chmod(0o755)

    # -- Node.js step -------------------------------------------------------

    def run_runtime_step(self, key_fingerprint: str) -> subprocess.CompletedProcess:
        calls = self.tmp / "calls.log"
        node_marker = self.tmp / "node-installed"
        self.stub("curl", 'echo "curl $*" >> "$CALLS"; out=""; while [[ $# -gt 0 ]]; do [[ $1 == -o ]] && out=$2; shift; done; echo "armored key" > "$out"\n')
        self.stub("gpg", 'if [[ "$1" == "--show-keys" ]]; then printf "pub:-:2048:1:2F59B5F99B1BE0B4:1::::::\\nfpr:::::::::%s:\\nfpr:::::::::%s:\\n" "$KEY_FPR" "$KEY_FPR"; else cat; fi\n')
        self.stub("dpkg", 'echo amd64\n')
        self.stub("apt-get", 'echo "apt-get $*" >> "$CALLS"; [[ "$*" == *nodejs* ]] && touch "$NODE_MARKER"; exit 0\n')
        self.stub("node", 'echo v22.11.0\n')
        for name in ("corepack", "pnpm", "pip3"):
            self.stub(name, 'exit 0\n')
        self.stub("python", 'echo "Python 3.12.0"\n')
        self.stub("python3", 'echo "Python 3.12.0"\n')

        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{posix(self.bin)}{os.pathsep}{env.get('PATH', '')}",
                "CALLS": posix(calls),
                "NODE_MARKER": posix(node_marker),
                "KEY_FPR": key_fingerprint,
                "SCRIPT_DIR": posix(INSTALL_DIR),
                "VEXLYX_APT_KEYRING_DIR": posix(self.tmp / "keyrings"),
                "VEXLYX_APT_SOURCES_DIR": posix(self.tmp / "sources.list.d"),
                "VEXLYX_APT_PREFERENCES_DIR": posix(self.tmp / "preferences.d"),
            }
        )
        command = (
            "log_step() { echo \"STEP $*\"; }; log_ok() { echo \"OK $*\"; }; "
            "log_warn() { echo \"WARN $*\"; }; die() { echo \"DIE $*\" >&2; exit 1; }; "
            'has_cmd() { if [[ "$1" == node ]]; then [[ -e "$NODE_MARKER" ]]; else return 0; fi; }; '
            f'source "{posix(STEPS / "04-runtime.sh")}"'
        )
        return subprocess.run([self.bash, "-c", command], capture_output=True, text=True, env=env)

    def calls(self) -> str:
        path = self.tmp / "calls.log"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def test_no_remote_script_is_executed(self) -> None:
        script = (STEPS / "04-runtime.sh").read_text(encoding="utf-8")
        self.assertNotIn("setup_22.x", script)
        self.assertNotIn("| bash -", script)

    def test_pinned_fingerprint_file_matches_the_expected_key(self) -> None:
        text = (INSTALL_DIR / "nodesource.fingerprint").read_text(encoding="utf-8")
        self.assertIn(PINNED, text)

    def test_key_with_wrong_fingerprint_aborts_before_trusting_it(self) -> None:
        result = self.run_runtime_step(OTHER)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the pinned fingerprint", result.stderr)
        self.assertNotIn("apt-get", self.calls())
        self.assertFalse((self.tmp / "keyrings" / "nodesource.gpg").exists())
        self.assertFalse((self.tmp / "sources.list.d" / "nodesource.list").exists())

    def test_key_with_correct_fingerprint_installs_from_the_pinned_repository(self) -> None:
        result = self.run_runtime_step(PINNED)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.tmp / "keyrings" / "nodesource.gpg").exists())
        sources = (self.tmp / "sources.list.d" / "nodesource.list").read_text(encoding="utf-8")
        self.assertIn("https://deb.nodesource.com/node_22.x", sources)
        self.assertIn("signed-by=", sources)
        self.assertIn("apt-get install -y --no-install-recommends nodejs", self.calls())

    def test_rerun_is_a_no_op_once_node_is_installed(self) -> None:
        first = self.run_runtime_step(PINNED)
        self.assertEqual(first.returncode, 0, first.stderr)
        keyring = (self.tmp / "keyrings" / "nodesource.gpg").read_bytes()
        calls_after_first = self.calls()

        second = self.run_runtime_step(PINNED)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("Node.js already installed", second.stdout)
        new_calls = self.calls()[len(calls_after_first):]
        self.assertNotIn("curl", new_calls)
        self.assertNotIn("nodejs", new_calls)
        self.assertEqual((self.tmp / "keyrings" / "nodesource.gpg").read_bytes(), keyring)

    def test_a_key_listing_with_two_primary_keys_is_refused_even_if_the_first_matches(self) -> None:
        # gpg is stubbed to list a second `pub` record after the pinned one.
        self.stub("gpg", 'printf "pub:-:2048:1:AAAA:1::::::\\nfpr:::::::::%s:\\npub:-:2048:1:BBBB:1::::::\\nfpr:::::::::%s:\\n" "$KEY_FPR" "$OTHER_FPR"\n')
        self.stub("curl", 'out=""; while [[ $# -gt 0 ]]; do [[ $1 == -o ]] && out=$2; shift; done; echo x > "$out"\n')
        env = os.environ.copy()
        env.update({"PATH": f"{posix(self.bin)}{os.pathsep}{env['PATH']}", "KEY_FPR": PINNED, "OTHER_FPR": OTHER, "SCRIPT_DIR": posix(INSTALL_DIR),
                    "VEXLYX_APT_KEYRING_DIR": posix(self.tmp / "keyrings"), "VEXLYX_APT_SOURCES_DIR": posix(self.tmp / "sources.list.d"),
                    "VEXLYX_APT_PREFERENCES_DIR": posix(self.tmp / "preferences.d")})
        command = (
            "log_step() { :; }; log_ok() { :; }; log_warn() { :; }; die() { echo \"DIE $*\" >&2; exit 1; }; "
            "has_cmd() { return 1; }; node() { echo v20.0.0; }; "
            f'source "{posix(STEPS / "04-runtime.sh")}"'
        )
        result = subprocess.run([self.bash, "-c", command], capture_output=True, text=True, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly one public key", result.stderr)
        self.assertFalse((self.tmp / "keyrings" / "nodesource.gpg").exists())


@unittest.skipUnless(shutil.which("gpg"), "gpg is required")
class RealKeyFileTest(unittest.TestCase):
    """The step run against real key files, so what gpg itself reports and what
    `gpg --dearmor` would put in the keyring is what is tested."""

    def setUp(self) -> None:
        self.bash = shutil.which("bash")
        if not self.bash:
            self.skipTest("bash is required")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.gnupg = self.tmp / "gnupg"
        self.gnupg.mkdir()
        self.gnupg.chmod(0o700)
        self.env = {**os.environ, "GNUPGHOME": native_posix(self.gnupg)}

    def gpg(self, *args: str) -> subprocess.CompletedProcess:
        result = subprocess.run(["gpg", "--batch", "--yes", *args], capture_output=True, env=self.env)
        if result.returncode != 0:
            self.fail(f"gpg {' '.join(args)} failed: {result.stderr.decode(errors='replace')}")
        return result

    def make_key(self, name: str) -> str:
        self.gpg("--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", f"{name} <{name}@example.com>", "ed25519", "sign", "never")
        listing = self.gpg("--list-keys", "--with-colons", f"{name}@example.com").stdout.decode()
        return next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))

    def armored(self, fingerprint: str, secret: bool = False) -> str:
        flag = "--export-secret-keys" if secret else "--export"
        return self.gpg("--armor", flag, fingerprint).stdout.decode().replace("\r\n", "\n")

    def run_step(self, key_text: str, pinned: str) -> tuple[subprocess.CompletedProcess, Path]:
        key_file = self.tmp / "downloaded.asc"
        key_file.write_text(key_text, encoding="utf-8", newline="\n")
        fingerprint_file = self.tmp / "pinned.fingerprint"
        fingerprint_file.write_text(pinned + "\n", encoding="utf-8", newline="\n")
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir(exist_ok=True)
        stubs = {
            "curl": 'out=""; while [[ $# -gt 0 ]]; do [[ $1 == -o ]] && out=$2; shift; done; cp "$KEY_FILE" "$out"\n',
            "dpkg": "echo amd64\n",
            "apt-get": 'echo "apt-get $*" >> "$CALLS"; exit 0\n',
            "node": "echo v22.11.0\n",
            "corepack": "exit 0\n", "pnpm": "exit 0\n", "pip3": "exit 0\n",
            "python": 'echo "Python 3.12.0"\n', "python3": 'echo "Python 3.12.0"\n',
        }
        for name, body in stubs.items():
            path = bin_dir / name
            path.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8", newline="\n")
            path.chmod(0o755)
        env = {
            **self.env,
            "PATH": f"{posix(bin_dir)}{os.pathsep}{os.environ['PATH']}",
            "KEY_FILE": posix(key_file),
            "CALLS": posix(self.tmp / "calls.log"),
            "SCRIPT_DIR": posix(INSTALL_DIR),
            "VEXLYX_NODESOURCE_FINGERPRINT_FILE": posix(fingerprint_file),
            "VEXLYX_APT_KEYRING_DIR": posix(self.tmp / "keyrings"),
            "VEXLYX_APT_SOURCES_DIR": posix(self.tmp / "sources.list.d"),
            "VEXLYX_APT_PREFERENCES_DIR": posix(self.tmp / "preferences.d"),
        }
        command = (
            "log_step() { :; }; log_ok() { :; }; log_warn() { :; }; die() { echo \"DIE $*\" >&2; exit 1; }; "
            'has_cmd() { [[ "$1" != node ]]; }; '
            f'source "{posix(STEPS / "04-runtime.sh")}"'
        )
        result = subprocess.run([self.bash, "-c", command], capture_output=True, text=True, env=env)
        return result, self.tmp / "keyrings" / "nodesource.gpg"

    def trusted_primary_fingerprints(self, keyring: Path) -> list[str]:
        listing = subprocess.run(["gpg", "--show-keys", "--with-colons", native_posix(keyring)], capture_output=True, text=True, env=self.env).stdout
        fingerprints, expect = [], False
        for line in listing.splitlines():
            fields = line.split(":")
            if fields[0] == "pub":
                expect = True
            elif fields[0] == "fpr" and expect:
                fingerprints.append(fields[9])
                expect = False
        return fingerprints

    def test_a_file_with_only_the_pinned_key_is_accepted_and_trusts_exactly_that_key(self) -> None:
        pinned = self.make_key("genuine")
        result, keyring = self.run_step(self.armored(pinned), pinned)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.trusted_primary_fingerprints(keyring), [pinned])

    def test_a_second_key_after_the_pinned_one_is_refused(self) -> None:
        pinned = self.make_key("genuine")
        extra = self.make_key("attacker")
        result, keyring = self.run_step(self.armored(pinned) + self.armored(extra), pinned)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly one public key", result.stderr)
        self.assertFalse(keyring.exists())
        self.assertFalse((self.tmp / "sources.list.d" / "nodesource.list").exists())
        self.assertFalse((self.tmp / "calls.log").exists(), "apt must not run")

    def test_a_second_key_before_the_pinned_one_is_refused(self) -> None:
        pinned = self.make_key("genuine")
        extra = self.make_key("attacker")
        result, keyring = self.run_step(self.armored(extra) + self.armored(pinned), pinned)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(keyring.exists())

    def test_a_different_single_key_is_refused_by_the_fingerprint(self) -> None:
        pinned = self.make_key("genuine")
        extra = self.make_key("attacker")
        result, keyring = self.run_step(self.armored(extra), pinned)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the pinned fingerprint", result.stderr)
        self.assertFalse(keyring.exists())

    def test_a_file_that_is_not_a_key_is_refused(self) -> None:
        pinned = self.make_key("genuine")
        result, keyring = self.run_step("<html>not a key</html>\n", pinned)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(keyring.exists())

    def test_a_file_carrying_the_secret_key_is_refused(self) -> None:
        pinned = self.make_key("genuine")
        result, keyring = self.run_step(self.armored(pinned, secret=True), pinned)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(keyring.exists())


class AdminPasswordTest(unittest.TestCase):
    """The generated admin password goes to a real terminal or nowhere."""

    def setUp(self) -> None:
        self.bash = shutil.which("bash")
        if not self.bash:
            self.skipTest("bash is required to execute the installer steps")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        stub = self.bin / "docker"
        stub.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8", newline="\n")
        stub.chmod(0o755)

    def command(self, log: Path, fd3: str, *, created: bool = True, generated: bool = True) -> str:
        return (
            f'source "{posix(INSTALL_DIR / "lib.sh")}"; '
            f'VEXLYX_STATE_FILE="{posix(log)}"; VEXLYX_SECRETS_FILE=/etc/vexlyx/vexlyx.env; '
            "log_step() { echo \"STEP $*\"; }; log_warn() { echo \"WARN $*\"; }; sleep() { :; }; "
            "VEXLYX_DOMAIN=panel.example.com; VEXLYX_BASE_DOMAIN=panel.example.com; VEXLYX_ADMIN_EMAIL=a@example.com; "
            "VEXLYX_MAIL_HOSTNAME=mail.example.com; VEXLYX_MAIL_DOMAIN=example.com; VEXLYX_HOME=/opt/vexlyx; VEXLYX_PUBLIC_IP=; "
            f"VEXLYX_ADMIN_PASSWORD={PASSWORD}; ADMIN_USER_CREATED={'true' if created else 'false'}; "
            f"ADMIN_PASSWORD_WAS_GENERATED={'true' if generated else 'false'}; "
            f'{fd3}exec > >(tee -a "{posix(log)}") 2>&1; '
            f'source "{posix(STEPS / "16-summary.sh")}"; '
            "command sleep 0.5"
        )

    def env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["PATH"] = f"{posix(self.bin)}{os.pathsep}{env.get('PATH', '')}"
        return env

    def run_without_terminal(self, fd3: str, **kwargs: bool) -> tuple[str, str, str]:
        """stdout is a pipe, as under `curl | bash > file` or in a CI log; a new
        session means there is no controlling terminal to fall back to."""
        log = self.tmp / "install.log"
        log.write_text("", encoding="utf-8")
        result = subprocess.run(
            [self.bash, "-c", self.command(log, fd3, **kwargs)],
            capture_output=True, text=True, env=self.env(), stdin=subprocess.DEVNULL,
            start_new_session=POSIX,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout, result.stderr, log.read_text(encoding="utf-8")

    def run_on_terminal(self, **kwargs: bool) -> tuple[str, str]:
        """stdout is a pty, i.e. the operator is watching the install."""
        if pty is None or not POSIX:
            self.skipTest("needs a pseudo-terminal (POSIX)")
        log = self.tmp / "install.log"
        log.write_text("", encoding="utf-8")
        master, slave = pty.openpty()
        process = subprocess.Popen(
            [self.bash, "-c", self.command(log, "exec 3>&1; ", **kwargs)],
            stdout=slave, stderr=slave, stdin=subprocess.DEVNULL, env=self.env(), start_new_session=True,
        )
        os.close(slave)
        output = b""
        while True:
            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            elif process.poll() is not None:
                break
        process.wait(timeout=20)
        os.close(master)
        self.assertEqual(process.returncode, 0, output.decode(errors="replace"))
        return output.decode(errors="replace"), log.read_text(encoding="utf-8")

    # -- a real terminal ----------------------------------------------------

    def test_generated_password_is_shown_on_the_terminal_but_never_logged(self) -> None:
        screen, log_text = self.run_on_terminal()
        self.assertIn(PASSWORD, screen)
        self.assertNotIn(PASSWORD, log_text)
        self.assertIn("not recorded in", log_text)

    def test_password_wording_states_where_it_lives(self) -> None:
        screen, _ = self.run_on_terminal()
        self.assertNotIn("not stored anywhere", screen)
        self.assertIn("Argon2id hash", screen)

    def test_existing_admin_gets_no_password_line_on_a_rerun(self) -> None:
        screen, log_text = self.run_on_terminal(created=False)
        self.assertNotIn(PASSWORD, screen)
        self.assertNotIn(PASSWORD, log_text)
        self.assertIn("already existed", screen)

    # -- stdout redirected: the password has nowhere safe to go ------------

    def assert_secret_withheld(self, stdout: str, stderr: str, log_text: str) -> None:
        for where, text in (("stdout", stdout), ("stderr", stderr), ("install log", log_text)):
            self.assertNotIn(PASSWORD, text, f"the password reached the {where}")
        self.assertIn("could not be shown", stdout)
        self.assertIn("deliberately not logged", stdout)

    def test_password_is_not_printed_when_stdout_is_a_pipe(self) -> None:
        self.assert_secret_withheld(*self.run_without_terminal("exec 3>&1; "))

    def test_password_is_not_written_to_a_file_the_installer_output_was_redirected_to(self) -> None:
        redirected = self.tmp / "installer-output.txt"
        stdout, stderr, log_text = self.run_without_terminal(f'exec 3>"{posix(redirected)}"; ')
        self.assertNotIn(PASSWORD, redirected.read_text(encoding="utf-8"))
        self.assert_secret_withheld(stdout, stderr, log_text)

    def test_password_is_not_printed_when_fd_3_is_closed_and_there_is_no_terminal(self) -> None:
        self.assert_secret_withheld(*self.run_without_terminal("exec 3>&-; "))

    # -- wiring ---------------------------------------------------------------

    def test_helper_requires_a_real_terminal_on_fd_3(self) -> None:
        text = (INSTALL_DIR / "lib.sh").read_text(encoding="utf-8")
        body = text[text.index("show_secret_to_operator()"):]
        self.assertIn("[[ -t 3 ]]", body.split("\n}\n")[0])

    def test_run_script_keeps_the_real_stdout_before_starting_the_tee(self) -> None:
        run_sh = (INSTALL_DIR / "run.sh").read_text(encoding="utf-8")
        self.assertIn("exec 3>&1", run_sh)
        self.assertLess(run_sh.index("exec 3>&1"), run_sh.index("tee -a"))

    def test_installer_never_enables_shell_tracing(self) -> None:
        for script in [INSTALL_DIR / "run.sh", INSTALL_DIR / "lib.sh", *STEPS.glob("*.sh")]:
            text = script.read_text(encoding="utf-8")
            self.assertNotIn("set -x", text, script.name)
            self.assertNotIn("set -o xtrace", text, script.name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
