#!/usr/bin/env python3
"""Fail CI when a tests/test_*.py is neither run nor deliberately excluded (#226).

The workflow used to name suites one by one, so a new suite could be added, come
back "test: pass", and never have executed. That is the gap this closes. It also
reports a named suite from which `unittest discover` collects nothing, which the
runner's Python answers with `NO TESTS RAN` and exit 5 — a failure that names no
file and explains nothing.
"""

import ast
import fnmatch
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCLUSIONS = ROOT / "tests" / "ci-excluded-suites.txt"
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

# Only a real `run:` step counts. A comment that happens to mention a suite name
# must not make it look covered.
RUN_STEP = re.compile(r"^\s*-\s*run:\s*(.*)$")
DISCOVER_PATTERN = re.compile(r"-p\s+['\"]?([A-Za-z0-9_.*]+\.py)['\"]?")
MODULE_FORM = re.compile(r"\btests\.(test_[A-Za-z0-9_]+)\b")


def run_commands(workflow_text: str) -> list:
    """The shell text of every `run:` step, including block scalars."""
    commands = []
    lines = workflow_text.split("\n")
    for index, line in enumerate(lines):
        match = RUN_STEP.match(line)
        if not match:
            continue
        command = match.group(1).strip()
        if command in ("|", "|-", ">", ">-"):
            indent = len(line) - len(line.lstrip())
            for following in lines[index + 1:]:
                if following.strip() and (len(following) - len(following.lstrip())) <= indent:
                    break
                commands.append(following.strip())
        elif command:
            commands.append(command)
    return commands


def named_patterns(workflow_text: str) -> set:
    """Suite filename patterns CI asks for, in either invocation form."""
    patterns = set()
    for command in run_commands(workflow_text):
        for pattern in DISCOVER_PATTERN.findall(command):
            patterns.add(pattern)
        for module in MODULE_FORM.findall(command):
            patterns.add(module + ".py")
    return patterns


def is_named(suite: str, patterns: set) -> bool:
    return any(fnmatch.fnmatchcase(suite, pattern) for pattern in patterns)


def read_exclusions(path: Path):
    """Return (reasons, problems). Every exclusion has to say why."""
    reasons = {}
    problems = []
    if not path.exists():
        return reasons, [f"{path.name} is missing"]
    for number, raw in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, reason = line.partition("#")
        name = name.strip()
        reason = reason.strip()
        if not separator or not reason:
            problems.append(f"{path.name}:{number} excludes {name or '(nothing)'} without a reason")
            continue
        if not name.endswith(".py"):
            problems.append(f"{path.name}:{number} names {name!r}, which is not a tests/*.py filename")
            continue
        if name in reasons:
            problems.append(f"{path.name}:{number} excludes {name} twice")
            continue
        reasons[name] = reason
    return reasons, problems


def collects_tests(path: Path) -> bool:
    """Whether `unittest discover` would find anything in this file.

    Static on purpose: importing the module to ask would run its top-level code,
    and some of these suites reach for a live panel or a docker daemon.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, SyntaxError):
        return False
    if any(isinstance(node, ast.FunctionDef) and node.name == "load_tests" for node in tree.body):
        return True

    bases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            names = []
            for base in node.bases:
                if isinstance(base, ast.Attribute):
                    names.append(base.attr)
                elif isinstance(base, ast.Name):
                    names.append(base.id)
            bases[node.name] = names

    # A suite may subclass a local base that is itself a TestCase.
    reached = set()
    while True:
        grown = {name for name, parents in bases.items()
                 if "TestCase" in parents or reached.intersection(parents)}
        if grown <= reached:
            break
        reached |= grown
    return bool(reached)


def check(root: Path = ROOT, workflow: Path = WORKFLOW, exclusions: Path = EXCLUSIONS) -> list:
    problems = []
    if not workflow.exists():
        return [f"{workflow} is missing"]
    patterns = named_patterns(workflow.read_text(encoding="utf-8"))
    reasons, exclusion_problems = read_exclusions(exclusions)
    problems.extend(exclusion_problems)
    suites = {path.name: path for path in sorted((root / "tests").glob("test_*.py"))}

    for name in sorted(reasons):
        if name not in suites:
            problems.append(f"{exclusions.name} excludes {name}, which no longer exists")
        elif is_named(name, patterns):
            problems.append(f"{name} is both excluded and run by CI; remove one of the two")

    for name, path in suites.items():
        if is_named(name, patterns):
            if not collects_tests(path):
                problems.append(
                    f"{name} is run by CI but defines no TestCase and no load_tests, "
                    "so unittest discover collects 0 tests from it"
                )
        elif name not in reasons:
            problems.append(
                f"{name} is neither run by CI nor listed in {exclusions.name}; "
                "wire it into the test job or write down why it is excluded"
            )
    return problems


def main() -> int:
    problems = check()
    if problems:
        print(f"CI suite coverage: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    patterns = named_patterns(WORKFLOW.read_text(encoding="utf-8"))
    reasons, _ = read_exclusions(EXCLUSIONS)
    suites = list((ROOT / "tests").glob("test_*.py"))
    run = sum(1 for path in suites if is_named(path.name, patterns))
    print(f"CI suite coverage: {len(suites)} suites, {run} run, {len(reasons)} excluded with a reason")
    return 0


if __name__ == "__main__":
    sys.exit(main())