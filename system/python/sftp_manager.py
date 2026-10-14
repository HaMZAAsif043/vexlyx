#!/usr/bin/env python3
"""
sftp_manager.py — SFTP account management for Vexlyx.
Manages Linux system users chrooted to /opt/vexlyx/projects/{userId}/.

All communication via stdin (JSON) → stdout (JSON).
Requires: sudo privileges for useradd, usermod, chpasswd.

Commands:
  sftp-provision     Create or verify a chrooted SFTP user
  sftp-rotate-password  Change the Linux account password
  sftp-add-ssh-key   Append an SSH public key to authorized_keys
  sftp-disable       Lock the Linux account
"""

import sys
import json
import subprocess
import os
import re
import stat
import shutil
from pathlib import Path

# ---------------------------------------------------------------------------
# Platform Detection
# ---------------------------------------------------------------------------

IS_POSIX = sys.platform != "win32" and shutil.which("useradd") is not None

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ok(data: dict):
    print(json.dumps({"success": True, **data}), flush=True)
    sys.exit(0)

def fail(message: str, code: str = "SFTP_ERROR"):
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)

def run(cmd: list[str], check=True) -> subprocess.CompletedProcess:
    if not IS_POSIX:
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")
    return subprocess.run(
        ["sudo"] + cmd,
        capture_output=True,
        text=True,
        check=check,
        timeout=60,
    )

def validate_username(username: str) -> bool:
    """Only allow usernames that match our safe pattern."""
    return bool(re.fullmatch(r"vsftp_[a-z0-9]{8,32}", username))

def validate_path(path: str) -> bool:
    """Ensure path does not contain path traversal characters."""
    if not path or ".." in path:
        return False
    return True

def sync_user_projects(chroot_dir: str, linux_username: str, projects: list):
    """
    Mounts or links project directories into the user's chroot jail.
    Each project lives at PROJECTS_DIR/<projectId>, and is exposed inside
    chrootDir/<projectName> so the SFTP user sees all their projects upon login.
    """
    if not os.path.isdir(chroot_dir):
        os.makedirs(chroot_dir, mode=0o755, exist_ok=True)

    for proj in projects:
        proj_name = proj.get("name", "")
        proj_path = proj.get("path", "")
        if not proj_path or not os.path.isdir(proj_path):
            continue

        safe_name = re.sub(r"[^a-zA-Z0-9_\-\.]", "_", proj_name).strip("._")
        if not safe_name:
            safe_name = re.sub(r"[^a-zA-Z0-9]", "", proj.get("id", "project"))[:16]

        target_dir = os.path.join(chroot_dir, safe_name)

        if IS_POSIX:
            os.makedirs(target_dir, mode=0o755, exist_ok=True)
            try:
                is_mounted = subprocess.run(["mountpoint", "-q", target_dir], check=False, timeout=60).returncode == 0
                if not is_mounted:
                    run(["mount", "--bind", proj_path, target_dir])
                if linux_username:
                    run(["chown", "-R", f"{linux_username}:{linux_username}", proj_path])
            except Exception:
                pass
        else:
            # Windows / dev fallback: directory junction or symlink
            if not os.path.exists(target_dir):
                try:
                    import _winapi
                    _winapi.CreateJunction(os.path.abspath(proj_path), os.path.abspath(target_dir))
                except Exception:
                    try:
                        os.symlink(os.path.abspath(proj_path), os.path.abspath(target_dir), target_is_directory=True)
                    except Exception:
                        pass


# ---------------------------------------------------------------------------
# Command: sftp-provision
# ---------------------------------------------------------------------------

def cmd_provision(payload: dict):
    user_id = payload.get("userId", "")
    password = payload.get("password", "")
    raw_chroot = payload.get("chrootDir", "")
    projects = payload.get("projects", [])

    if not user_id or not password or not raw_chroot:
        fail("userId, password, and chrootDir are required", "SFTP_MISSING_ARGS")

    if not validate_path(raw_chroot):
        fail("Invalid chrootDir path", "SFTP_INVALID_PATH")

    chroot_dir = os.path.abspath(raw_chroot)

    # Derive a deterministic safe username from the userId
    safe_suffix = re.sub(r"[^a-z0-9]", "", user_id.lower())[:20]
    linux_username = f"vsftp_{safe_suffix}"

    if not validate_username(linux_username):
        fail(f"Derived username '{linux_username}' is invalid", "SFTP_INVALID_USERNAME")

    # Create chroot base directory
    os.makedirs(chroot_dir, mode=0o755, exist_ok=True)

    if IS_POSIX:
        # Check if user already exists
        result = run(["id", linux_username], check=False)
        user_exists = result.returncode == 0

        if not user_exists:
            # Chroot directory must be owned by root (OpenSSH requirement)
            run(["chown", "root:root", chroot_dir])
            run(["chmod", "755", chroot_dir])

            # Create the SFTP-only Linux user
            run([
                "useradd",
                "--no-create-home",
                "--shell", "/usr/sbin/nologin",
                "--home-dir", chroot_dir,
                linux_username,
            ])

        # Set / reset password
        proc = subprocess.run(
            ["sudo", "chpasswd"],
            input=f"{linux_username}:{password}",
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode != 0:
            fail(f"chpasswd failed: {proc.stderr}", "SFTP_CHPASSWD_FAILED")

        # Ensure SSH key dir exists inside chroot home
        ssh_dir = os.path.join(chroot_dir, ".ssh")
        os.makedirs(ssh_dir, mode=0o700, exist_ok=True)
        run(["chown", f"{linux_username}:{linux_username}", ssh_dir])

        # Write OpenSSH sshd_config match block (idempotent — keyed on username)
        sshd_snippet = f"""
# Vexlyx SFTP — {linux_username}
Match User {linux_username}
    ChrootDirectory {chroot_dir}
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
"""
        sshd_conf_path = "/etc/ssh/sshd_config.d/vexlyx-sftp.conf"
        try:
            existing = ""
            if os.path.exists(sshd_conf_path):
                with open(sshd_conf_path, "r", encoding="utf-8") as f:
                    existing = f.read()

            if f"Match User {linux_username}" not in existing:
                with open(sshd_conf_path, "a", encoding="utf-8") as f:
                    f.write(sshd_snippet)

            # Reload sshd to pick up the new block
            run(["systemctl", "reload", "sshd"], check=False)
        except Exception:
            # Non-fatal in dev environments
            pass
    else:
        # Development / Windows fallback: ensure .ssh dir exists
        ssh_dir = os.path.join(chroot_dir, ".ssh")
        os.makedirs(ssh_dir, mode=0o700, exist_ok=True)

    # Sync project directory mapping into chroot
    sync_user_projects(chroot_dir, linux_username, projects)

    ok({"linuxUsername": linux_username})

# ---------------------------------------------------------------------------
# Command: sftp-rotate-password
# ---------------------------------------------------------------------------

def cmd_rotate_password(payload: dict):
    username = payload.get("linuxUsername", "")
    password = payload.get("password", "")

    if not validate_username(username):
        fail("Invalid or unsafe username", "SFTP_INVALID_USERNAME")

    if IS_POSIX:
        proc = subprocess.run(
            ["sudo", "chpasswd"],
            input=f"{username}:{password}",
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode != 0:
            fail(f"chpasswd failed: {proc.stderr}", "SFTP_CHPASSWD_FAILED")

    ok({})

# ---------------------------------------------------------------------------
# Command: sftp-add-ssh-key
# ---------------------------------------------------------------------------

def cmd_add_ssh_key(payload: dict):
    username = payload.get("linuxUsername", "")
    public_key = payload.get("publicKey", "").strip()
    raw_chroot = payload.get("chrootDir", "")

    if not validate_username(username):
        fail("Invalid or unsafe username", "SFTP_INVALID_USERNAME")

    if not public_key.startswith(("ssh-", "ecdsa-", "sk-")):
        fail("Invalid SSH public key format", "SFTP_INVALID_KEY")

    ssh_dir = None
    if IS_POSIX:
        # Get home dir via getent
        result = run(["getent", "passwd", username])
        parts = result.stdout.strip().split(":")
        if len(parts) >= 6:
            home_dir = parts[5]
            ssh_dir = os.path.join(home_dir, ".ssh")
    elif raw_chroot:
        ssh_dir = os.path.join(os.path.abspath(raw_chroot), ".ssh")

    if ssh_dir:
        os.makedirs(ssh_dir, mode=0o700, exist_ok=True)
        auth_keys_path = os.path.join(ssh_dir, "authorized_keys")

        existing_keys = []
        if os.path.exists(auth_keys_path):
            with open(auth_keys_path, "r", encoding="utf-8") as f:
                existing_keys = f.read().splitlines()

        if public_key not in existing_keys:
            with open(auth_keys_path, "a", encoding="utf-8") as f:
                f.write(public_key + "\n")
            if IS_POSIX:
                run(["chown", f"{username}:{username}", auth_keys_path])
                run(["chmod", "600", auth_keys_path])

    ok({})

# ---------------------------------------------------------------------------
# Command: sftp-disable
# ---------------------------------------------------------------------------

def cmd_disable(payload: dict):
    username = payload.get("linuxUsername", "")

    if not validate_username(username):
        fail("Invalid or unsafe username", "SFTP_INVALID_USERNAME")

    if IS_POSIX:
        run(["usermod", "--lock", username])

    ok({})

# ---------------------------------------------------------------------------
# Command: sftp-enable
# ---------------------------------------------------------------------------

def cmd_enable(payload: dict):
    username = payload.get("linuxUsername", "")

    if not validate_username(username):
        fail("Invalid or unsafe username", "SFTP_INVALID_USERNAME")

    if IS_POSIX:
        run(["usermod", "--unlock", username])

    ok({})

# ---------------------------------------------------------------------------
# Command: sftp-sync-projects
# ---------------------------------------------------------------------------

def cmd_sync_projects(payload: dict):
    raw_chroot = payload.get("chrootDir", "")
    username = payload.get("linuxUsername", "")
    projects = payload.get("projects", [])

    if not raw_chroot or not validate_path(raw_chroot):
        fail("Invalid chrootDir path", "SFTP_INVALID_PATH")

    chroot_dir = os.path.abspath(raw_chroot)
    sync_user_projects(chroot_dir, username, projects)
    ok({"synced": len(projects)})

# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except Exception as e:
        fail(f"Failed to parse input JSON: {e}", "SFTP_PARSE_ERROR")
        return

    command = payload.get("command", "")

    dispatch = {
        "sftp-provision": cmd_provision,
        "sftp-rotate-password": cmd_rotate_password,
        "sftp-add-ssh-key": cmd_add_ssh_key,
        "sftp-disable": cmd_disable,
        "sftp-enable": cmd_enable,
        "sftp-sync-projects": cmd_sync_projects,
    }

    handler = dispatch.get(command)
    if not handler:
        fail(f"Unknown command: {command}", "SFTP_UNKNOWN_COMMAND")
        return

    try:
        handler(payload)
    except subprocess.TimeoutExpired as exc:
        fail(f"Command timed out after {exc.timeout}s", "COMMAND_TIMEOUT")

if __name__ == "__main__":
    main()
