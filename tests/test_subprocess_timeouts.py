import importlib.util
import io
import json
import re
import subprocess
import sys
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path


PYTHON_DIR = Path(__file__).parents[1] / "system" / "python"


def load(name: str):
    path = PYTHON_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


MANAGERS = {name: load(name) for name in ("docker_manager", "build_manager")}
SLEEP_FOREVER = [sys.executable, "-c", "import time; time.sleep(60)"]

# Starts a long-lived grandchild that inherits stdout, then waits. Killing only
# the direct child leaves the grandchild holding the pipe open, so a reader
# blocks until the grandchild exits.
SPAWNS_GRANDCHILD = [
    sys.executable,
    "-c",
    "import subprocess, sys, time\n"
    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
    "print('started', flush=True)\n"
    "time.sleep(60)\n",
]


class TestRunBounded(unittest.TestCase):
    def test_returns_the_result_when_the_command_finishes_in_time(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                result = module.run_bounded(
                    10,
                    [sys.executable, "-c", "print('hi')"],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout.strip(), "hi")

    def test_check_raises_on_a_failing_command(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                with self.assertRaises(subprocess.CalledProcessError):
                    module.run_bounded(
                        10,
                        [sys.executable, "-c", "import sys; sys.exit(3)"],
                        capture_output=True,
                        check=True,
                    )

    def test_passes_stdin_input_through(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                result = module.run_bounded(
                    10,
                    [sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"],
                    capture_output=True,
                    text=True,
                    input="abc",
                )
                self.assertEqual(result.stdout.strip(), "ABC")

    def test_a_hung_command_is_killed_and_reported_as_a_timeout(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                out = io.StringIO()
                started = time.monotonic()
                with redirect_stdout(out), self.assertRaises(SystemExit) as ctx:
                    module.run_bounded(1, SLEEP_FOREVER, capture_output=True)
                elapsed = time.monotonic() - started

                self.assertEqual(ctx.exception.code, 1)
                self.assertLess(elapsed, 15)
                payload = json.loads(out.getvalue().strip().splitlines()[-1])
                self.assertEqual(payload["code"], "COMMAND_TIMEOUT")
                self.assertIn("timed out after 1s", payload["error"])

    def test_non_fatal_timeout_returns_instead_of_exiting_so_later_steps_run(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                out = io.StringIO()
                with redirect_stdout(out):
                    result = module.run_bounded(1, SLEEP_FOREVER, fatal=False, capture_output=True)
                    follow_up = module.run_bounded(
                        10, [sys.executable, "-c", "print('ran')"], capture_output=True, text=True
                    )

                self.assertEqual(result.returncode, 124)
                self.assertEqual(follow_up.stdout.strip(), "ran")
                self.assertNotIn("COMMAND_TIMEOUT", out.getvalue())

    def test_a_grandchild_holding_the_pipe_does_not_defeat_the_deadline(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                out = io.StringIO()
                started = time.monotonic()
                with redirect_stdout(out), self.assertRaises(SystemExit):
                    module.run_bounded(2, SPAWNS_GRANDCHILD, capture_output=True)
                elapsed = time.monotonic() - started

                # Without tree-kill this blocks for the grandchild's 60s sleep.
                self.assertLess(elapsed, 20)
                payload = json.loads(out.getvalue().strip().splitlines()[-1])
                self.assertEqual(payload["code"], "COMMAND_TIMEOUT")


class TestStreamWithDeadline(unittest.TestCase):
    def popen(self, module, code_or_argv, grouped: bool = False) -> subprocess.Popen:
        argv = (
            code_or_argv
            if isinstance(code_or_argv, list)
            else [sys.executable, "-u", "-c", code_or_argv]
        )
        extra = module._group_popen_kwargs() if grouped else {}
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            **extra,
        )
        self.addCleanup(proc.stdout.close)
        return proc

    def test_delivers_every_line_and_reports_no_timeout(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                proc = self.popen(module, "print('a'); print('b')")
                lines = []
                timed_out = module.stream_with_deadline(proc, 10, lines.append)

                self.assertFalse(timed_out)
                self.assertEqual([l.strip() for l in lines], ["a", "b"])
                self.assertEqual(proc.returncode, 0)

    def test_kills_a_process_that_outlives_the_deadline(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                proc = self.popen(module, "import time; print('start'); time.sleep(60)")
                lines = []
                started = time.monotonic()
                timed_out = module.stream_with_deadline(proc, 1, lines.append)
                elapsed = time.monotonic() - started

                self.assertTrue(timed_out)
                self.assertLess(elapsed, 15)
                self.assertIsNotNone(proc.poll())
                self.assertIn("start", "".join(lines))

    def test_kills_the_whole_tree_so_a_surviving_grandchild_cannot_block_the_reader(self):
        for name, module in MANAGERS.items():
            with self.subTest(manager=name):
                proc = self.popen(module, SPAWNS_GRANDCHILD, grouped=True)
                lines = []
                started = time.monotonic()
                timed_out = module.stream_with_deadline(proc, 2, lines.append)
                elapsed = time.monotonic() - started

                self.assertTrue(timed_out)
                # Without tree-kill the reader waits for the grandchild's 60s.
                self.assertLess(elapsed, 20)


class TestNoUnboundedRun(unittest.TestCase):
    """Regression guard for #52: no unbounded subprocess.run in the managers."""

    def test_every_direct_subprocess_run_is_time_limited(self):
        for name in MANAGERS:
            with self.subTest(manager=name):
                source = (PYTHON_DIR / f"{name}.py").read_text(encoding="utf-8")
                calls = list(re.finditer(r"subprocess\.run\(", source))
                self.assertGreaterEqual(len(calls), 1)
                for m in calls:
                    depth, i = 0, m.end() - 1
                    while i < len(source):
                        depth += {"(": 1, ")": -1}.get(source[i], 0)
                        i += 1
                        if depth == 0:
                            break
                    self.assertIn("timeout=", source[m.start() : i])

    def test_run_bounded_does_not_use_the_tree_unaware_subprocess_run(self):
        for name in MANAGERS:
            with self.subTest(manager=name):
                source = (PYTHON_DIR / f"{name}.py").read_text(encoding="utf-8")
                helper = source[source.index("def run_bounded") : source.index("def stream_with_deadline")]
                self.assertNotIn("subprocess.run(", helper)
                self.assertIn("kill_process_tree(proc)", helper)

    def test_other_managers_bound_every_direct_call(self):
        for name in (
            "git_manager",
            "backup_manager",
            "postfix_manager",
            "sftp_manager",
            "service_status_manager",
        ):
            with self.subTest(manager=name):
                source = (PYTHON_DIR / f"{name}.py").read_text(encoding="utf-8")
                for m in re.finditer(r"subprocess\.run\(", source):
                    depth, i = 0, m.end() - 1
                    while i < len(source):
                        depth += {"(": 1, ")": -1}.get(source[i], 0)
                        i += 1
                        if depth == 0:
                            break
                    self.assertIn("timeout", source[m.start() : i])

    def test_timeouts_are_reported_not_left_as_tracebacks(self):
        for name in ("sftp_manager", "backup_manager", "service_status_manager"):
            with self.subTest(manager=name):
                source = (PYTHON_DIR / f"{name}.py").read_text(encoding="utf-8")
                self.assertIn("except subprocess.TimeoutExpired", source)
                self.assertIn("COMMAND_TIMEOUT", source)


if __name__ == "__main__":
    unittest.main()
