#!/usr/bin/env python3
"""
git_manager.py — System-layer script for Vexlyx Git operations.

Called by the API service via child_process.spawn with a JSON payload on stdin.
Writes a JSON result to stdout and exits with code 0 on success, 1 on error.

Commands:
  clone            — Clone a git repo into the project workspace directory
  generate_ssh_key — Generate an Ed25519 SSH key pair for private repo access

Never run this script as root.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def respond(data: dict) -> None:
    """Write a JSON result to stdout and flush."""
    print(json.dumps(data), flush=True)


def fail(message: str, code: str = "GIT_ERROR") -> None:
    """Write a JSON error to stdout and exit 1."""
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)


def require_field(payload: dict, field: str) -> str:
    value = payload.get(field)
    if not value or not isinstance(value, str):
        fail(f"Missing required field: {field}", "INVALID_PAYLOAD")
    return value  # type: ignore[return-value]  — fail() exits


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_clone(payload: dict) -> None:
    """
    Clone a git repository into the project workspace.

    Payload fields:
      projectId        — used to construct the clone destination
      gitUrl           — HTTPS or SSH git URL
      branch           — branch to clone (default: main)
      projectsDir      — base directory for all project workspaces
      sshPrivateKeyPath — optional; if set, clone uses SSH with this key
      accessToken       — optional short-lived HTTPS credential
    """
    project_id = require_field(payload, "projectId")
    git_url = require_field(payload, "gitUrl")
    # Enforce the same public-host policy as the shared API schemas before
    # network access or workspace deletion, including URLs persisted previously.
    if not re.fullmatch(
        r"(?:https://(?:github\.com|gitlab\.com|bitbucket\.org)/|git@(?:github\.com|gitlab\.com|bitbucket\.org):)"
        r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+", git_url,
    ):
        fail("Unsupported Git repository URL", "INVALID_GIT_URL")
    branch = payload.get("branch", "main")
    projects_dir = require_field(payload, "projectsDir")
    ssh_key_path = payload.get("sshPrivateKeyPath")
    access_token = payload.get("accessToken")

    dest = Path(projects_dir) / project_id
    env = _build_env(ssh_key_path, access_token)

    # If the workspace already exists and has a valid .git repo, try fetch + checkout
    if (dest / ".git").exists():
        try:
            # The URL never contains credentials; setting it before fetch also makes
            # switching a project between repositories deterministic.
            _run(["git", "-C", str(dest), "remote", "set-url", "origin", git_url], env=env)
            _run(["git", "-C", str(dest), "fetch", "origin"], env=env)
            _run(["git", "-C", str(dest), "checkout", branch], env=env)
            _run(["git", "-C", str(dest), "pull", "origin", branch], env=env)
            respond({"success": True, "path": str(dest), "action": "pulled"})
            return
        except SystemExit:
            # If pull/fetch failed (e.g. broken repo or URL changed), clean it up and re-clone
            shutil.rmtree(dest, ignore_errors=True)

    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)

    try:
        _run(
            ["git", "clone", "--branch", branch, "--single-branch", git_url, str(dest)],
            env=env,
        )
    except SystemExit:
        # Clean up partial failed directory
        shutil.rmtree(dest, ignore_errors=True)
        raise

    respond({"success": True, "path": str(dest), "action": "cloned"})


def cmd_generate_ssh_key(payload: dict) -> None:
    """
    Generate an Ed25519 SSH key pair for a project.

    Payload fields:
      projectId — used to name the key directory
      keysDir   — base directory for SSH keys

    Returns:
      { publicKey: string }  — the public key content to store in the DB and
                               display to the user as a GitHub Deploy Key.
    """
    project_id = require_field(payload, "projectId")
    keys_dir = require_field(payload, "keysDir")

    key_dir = Path(keys_dir) / project_id
    key_dir.mkdir(parents=True, exist_ok=True)

    private_key_path = key_dir / "id_ed25519"
    public_key_path = key_dir / "id_ed25519.pub"

    # Remove existing key pair before regenerating
    private_key_path.unlink(missing_ok=True)
    public_key_path.unlink(missing_ok=True)

    _run([
        "ssh-keygen",
        "-t", "ed25519",
        "-C", f"vexlyx-project-{project_id}",
        "-f", str(private_key_path),
        "-N", "",  # empty passphrase
    ])

    # Restrict private key permissions (ssh-keygen does this on Unix already,
    # but we set explicitly for clarity)
    try:
        private_key_path.chmod(0o600)
    except Exception:
        pass  # non-fatal on Windows

    public_key = public_key_path.read_text().strip()

    respond({
        "success": True,
        "publicKey": public_key,
        "privateKeyPath": str(private_key_path.resolve()),
    })


# ---------------------------------------------------------------------------
# Internal utilities
# ---------------------------------------------------------------------------

def _build_env(ssh_key_path: str | None, access_token: str | None = None) -> dict:
    """Build the subprocess environment, injecting GIT_SSH_COMMAND when needed."""
    env = os.environ.copy()
    if ssh_key_path:
        # Use forward slashes because git treats backslashes in GIT_SSH_COMMAND as escape sequences
        posix_key_path = Path(ssh_key_path).as_posix()
        # StrictHostKeyChecking=accept-new avoids interactive prompts while still
        # protecting against MITM on subsequent connections.
        env["GIT_SSH_COMMAND"] = (
            f'ssh -i "{posix_key_path}" '
            "-o StrictHostKeyChecking=accept-new "
            "-o BatchMode=yes"
        )
    if access_token:
        import base64
        credential = base64.b64encode(f"x-access-token:{access_token}".encode()).decode()
        env["GIT_CONFIG_COUNT"] = "1"
        env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
        env["GIT_CONFIG_VALUE_0"] = f"Authorization: Basic {credential}"
    return env


# Seconds. Generous because large repositories legitimately take a while to
# clone; the point is that a stalled remote cannot hang the worker forever.
GIT_COMMAND_TIMEOUT = 900


def _run(args: list[str], env: dict | None = None) -> None:
    """Run a subprocess, capturing combined output, failing on non-zero exit."""
    if args[0] == "git":
        # Redirects must not escape the validated host boundary.
        args = [args[0], "-c", "http.followRedirects=false", *args[1:]]
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            env=env,
            timeout=GIT_COMMAND_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        # A stalled remote must not hold the build worker forever (#52).
        fail(
            f"Command timed out after {GIT_COMMAND_TIMEOUT}s: {' '.join(args)}",
            "COMMAND_TIMEOUT",
        )
        return
    if result.returncode != 0:
        error_output = (result.stderr or result.stdout or "").strip()
        fail(f"Command failed: {' '.join(args)}\n{error_output}", "COMMAND_FAILED")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

COMMANDS = {
    "clone": cmd_clone,
    "generate_ssh_key": cmd_generate_ssh_key,
}


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        fail("No input received on stdin", "NO_INPUT")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Invalid JSON payload: {exc}", "INVALID_JSON")
        return  # unreachable — fail() exits; here for type checker

    command = payload.get("command")
    if command not in COMMANDS:
        fail(
            f"Unknown command '{command}'. Valid: {', '.join(COMMANDS)}",
            "UNKNOWN_COMMAND",
        )
        return

    COMMANDS[command](payload)


if __name__ == "__main__":
    main()
