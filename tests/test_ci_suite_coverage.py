"""The CI suite-coverage guard has to fail when coverage is missing (#226).

`ci.yml` names Python suites one by one. PR #225 added a suite whose four tests
were the whole evidence for its fix; the first push came back "test: pass" and
the suite had never run, because nothing named it. `check_ci_suite_coverage.py`
is the completeness check for that allowlist, so these tests drive it against
small synthetic repositories and assert both directions: a gap is reported, and
a covered suite is not.

One test also runs the guard against this repository, so removing the guard's
step from the workflow does not silently remove the check.
"""

import importlib.util
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location(
    "check_ci_suite_coverage", REPO_ROOT / "tests" / "check_ci_suite_coverage.py"
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

TESTCASE_SUITE = """import unittest


class Thing(unittest.TestCase):
    def test_ok(self):
        self.assertTrue(True)
"""

SCRIPT_SUITE = """def test_ok():
    assert True


def main():
    test_ok()


if __name__ == "__main__":
    main()
"""

DISCOVER = "python3 -m unittest discover -s tests -p test_thing.py"
MODULE = "python3 -m unittest tests.test_thing -v"


def workflow_text(commands):
    lines = ["jobs:", "  test:", "    steps:"]
    lines.extend(f"      - run: {command}" for command in commands)
    return "\n".join(lines) + "\n"


class CoverageGuardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "tests").mkdir()
        self.workflow = self.root / "ci.yml"
        self.exclusions = self.root / "ci-excluded-suites.txt"

    def build(self, suites=None, commands=(), exclusions="", workflow=None):
        for name, source in (suites if suites is not None else {"test_thing.py": TESTCASE_SUITE}).items():
            (self.root / "tests" / name).write_text(source, encoding="utf-8")
        self.workflow.write_text(
            workflow if workflow is not None else workflow_text(commands), encoding="utf-8"
        )
        self.exclusions.write_text(exclusions, encoding="utf-8")

    def problems(self):
        return guard.check(root=self.root, workflow=self.workflow, exclusions=self.exclusions)

    def test_discover_form_counts_as_named(self):
        self.build(commands=[DISCOVER])
        self.assertEqual(self.problems(), [])

    def test_module_form_counts_as_named(self):
        self.build(commands=[MODULE])
        self.assertEqual(self.problems(), [])

    def test_glob_pattern_covers_matching_suites(self):
        self.build(
            suites={"test_thing.py": TESTCASE_SUITE, "test_other.py": TESTCASE_SUITE},
            commands=["python3 -m unittest discover -s tests -p 'test_*.py'"],
        )
        self.assertEqual(self.problems(), [])

    def test_unnamed_suite_is_reported(self):
        self.build(commands=["python3 -m unittest discover -s tests -p test_elsewhere.py"])
        problems = self.problems()
        self.assertEqual(len(problems), 1)
        self.assertIn("test_thing.py is neither run by CI nor listed", problems[0])

    def test_comment_mentioning_a_suite_is_not_coverage(self):
        self.build(
            workflow=workflow_text([]) + "      # " + DISCOVER + "\n",
        )
        self.assertEqual(len(self.problems()), 1)

    def test_block_scalar_run_step_is_read(self):
        self.build(
            workflow=(
                "jobs:\n"
                "  test:\n"
                "    steps:\n"
                "      - run: |\n"
                "          cd tests\n"
                "          " + DISCOVER + "\n"
                "      - run: echo done\n"
            )
        )
        self.assertEqual(self.problems(), [])

    def test_block_scalar_stops_at_the_next_step(self):
        # The suite name sits under the *following* key, not under the run step.
        self.build(
            suites={"test_thing.py": TESTCASE_SUITE},
            workflow=(
                "jobs:\n"
                "  test:\n"
                "    steps:\n"
                "      - run: |\n"
                "          echo hello\n"
                "      - name: " + DISCOVER + "\n"
            ),
        )
        self.assertEqual(len(self.problems()), 1)

    def test_exclusion_with_a_reason_is_accepted(self):
        self.build(exclusions="test_thing.py  # needs a docker daemon\n")
        self.assertEqual(self.problems(), [])

    def test_exclusion_without_a_reason_is_reported(self):
        self.build(exclusions="test_thing.py\n")
        problems = self.problems()
        self.assertTrue(any("without a reason" in problem for problem in problems), problems)

    def test_exclusion_with_an_empty_reason_is_reported(self):
        self.build(exclusions="test_thing.py  #\n")
        problems = self.problems()
        self.assertTrue(any("without a reason" in problem for problem in problems), problems)

    def test_exclusion_of_a_missing_file_is_reported(self):
        self.build(exclusions="test_gone.py  # needed a mail server\n")
        problems = self.problems()
        self.assertTrue(any("test_gone.py, which no longer exists" in p for p in problems), problems)

    def test_excluded_and_named_is_reported(self):
        self.build(commands=[DISCOVER], exclusions="test_thing.py  # needs a docker daemon\n")
        problems = self.problems()
        self.assertTrue(any("both excluded and run by CI" in problem for problem in problems), problems)

    def test_duplicate_exclusion_is_reported(self):
        self.build(exclusions="test_thing.py  # one\ntest_thing.py  # two\n")
        problems = self.problems()
        self.assertTrue(any("excludes test_thing.py twice" in problem for problem in problems), problems)

    def test_exclusion_that_is_not_a_suite_filename_is_reported(self):
        self.build(exclusions="thing  # needs a docker daemon\n")
        problems = self.problems()
        self.assertTrue(any("not a tests/*.py filename" in problem for problem in problems), problems)

    def test_missing_exclusion_file_is_reported(self):
        self.build(commands=[DISCOVER])
        self.exclusions.unlink()
        problems = self.problems()
        self.assertTrue(any("ci-excluded-suites.txt is missing" in problem for problem in problems), problems)

    def test_missing_workflow_is_reported(self):
        self.build(commands=[DISCOVER])
        self.workflow.unlink()
        self.assertEqual(len(self.problems()), 1)

    def test_named_script_style_suite_is_reported(self):
        self.build(suites={"test_thing.py": SCRIPT_SUITE}, commands=[DISCOVER])
        problems = self.problems()
        self.assertEqual(len(problems), 1)
        self.assertIn("collects 0 tests", problems[0])

    def test_unnamed_script_style_suite_is_only_a_coverage_problem(self):
        self.build(suites={"test_thing.py": SCRIPT_SUITE})
        problems = self.problems()
        self.assertEqual(len(problems), 1)
        self.assertIn("neither run by CI nor listed", problems[0])

    def test_excluded_script_style_suite_is_accepted(self):
        self.build(
            suites={"test_thing.py": SCRIPT_SUITE},
            exclusions="test_thing.py  # script-style, run by hand\n",
        )
        self.assertEqual(self.problems(), [])


class CollectsTestsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "test_sample.py"

    def collects(self, source):
        self.path.write_text(source, encoding="utf-8")
        return guard.collects_tests(self.path)

    def test_testcase_subclass(self):
        self.assertTrue(self.collects(TESTCASE_SUITE))

    def test_module_level_functions_are_not_collected(self):
        self.assertFalse(self.collects(SCRIPT_SUITE))

    def test_load_tests_hook_is_collected(self):
        self.assertTrue(self.collects("def load_tests(loader, tests, pattern):\n    return tests\n"))

    def test_local_base_class_is_resolved(self):
        self.assertTrue(
            self.collects(
                "import unittest\n\n\n"
                "class Base(unittest.TestCase):\n    pass\n\n\n"
                "class Middle(Base):\n    pass\n\n\n"
                "class Thing(Middle):\n    def test_ok(self):\n        pass\n"
            )
        )

    def test_unrelated_class_is_not_collected(self):
        self.assertFalse(self.collects("class Helper:\n    def test_ok(self):\n        pass\n"))

    def test_unparseable_file_is_not_collected(self):
        self.assertFalse(self.collects("def broken(:\n"))

    def test_missing_file_is_not_collected(self):
        self.assertFalse(guard.collects_tests(self.path))


class RepositoryCoverageTests(unittest.TestCase):
    def test_this_repository_has_no_coverage_gaps(self):
        self.assertEqual(guard.check(), [], "run tests/check_ci_suite_coverage.py for the list")


if __name__ == "__main__":
    unittest.main()