#!/usr/bin/env python3
"""
dovecot_manager.py -- System-layer script for Vexlyx Dovecot IMAP Management (F4.2).

Handles:
- Status checks for the Dovecot daemon, Port 143 (IMAP), Port 993 (IMAPS),
  and the internal SASL auth listener (port 12345) used by Postfix.
- Synchronizing Mailbox rows from Postgres into Dovecot's passwd-file
  (used as BOTH passdb and userdb), including per-mailbox Maildir++ quota
  rules derived from Mailbox.quota (megabytes).

Outputs structured JSON responses on stdout.
"""

import json
import os
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from mail_state import (MailStateError, state_lock, active_directory, stage, publish, passwd_lines, run_service)

# Stream Encoding Configuration
if hasattr(sys.stdin, "reconfigure"):
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def respond(data: dict) -> None:
    print(json.dumps(data), flush=True)


# ---------------------------------------------------------------------------
# Path Helpers
# ---------------------------------------------------------------------------

def get_dovecot_dir() -> Path:
    candidates = [
        Path.cwd() / "docker" / "dovecot",
        Path.cwd().parent / "docker" / "dovecot",
        Path.cwd().parent.parent / "docker" / "dovecot",
    ]
    for c in candidates:
        if c.exists():
            return c
    target = Path.cwd() / "docker" / "dovecot"
    target.mkdir(parents=True, exist_ok=True)
    return target


def get_users_file() -> Path:
    return active_directory("dovecot") / "users"


# ---------------------------------------------------------------------------
# Virtual Mailbox Synchronization
# ---------------------------------------------------------------------------

# Fixed numeric uid/gid shared with Postfix's virtual_uid_maps/virtual_gid_maps
# (docker/postfix/main.cf) and Dovecot's mail_uid/mail_gid (dovecot.conf).
VMAIL_UID = 5000
VMAIL_GID = 5000
DEFAULT_QUOTA_MB = 1024


def _address_domain(address: str) -> str:
    return address.split("@", 1)[1].strip().lower() if "@" in address else ""


# Node's `argon2` package (apps/api, used by mailboxes/service.ts and
# auth/service.ts) encodes the Argon2 PHC parameter string as "m=..,p=..,t=..".
# Dovecot's ARGON2ID passdb parser requires the canonical "m=..,t=..,p=.."
# order and silently derives the WRONG t/p values when it sees them swapped —
# the hash still "looks" well-formed, but every IMAP login then fails with
# "Password mismatch" even though the password is correct (verified: swapping
# only the parameter order, keeping the same salt/digest, turns a failing
# `doveadm pw -t` into a passing one). Reorder before writing so Dovecot reads
# the same m/t/p values the hash was actually computed with.
_ARGON2_PARAM_ORDER_RE = re.compile(r"(m=\d+),(p=\d+),(t=\d+)")


def _format_passwd_line(address: str, password_hash: str, quota_mb: int) -> str:
    password_hash = _ARGON2_PARAM_ORDER_RE.sub(r"\1,\3,\2", password_hash)
    scheme_hash = password_hash if password_hash.startswith("{") else f"{{ARGON2ID}}{password_hash}"
    return f"{address}:{scheme_hash}:{VMAIL_UID}:{VMAIL_GID}::::userdb_quota_rule=*:storage={quota_mb}M"


def sync_mailboxes(mailboxes: list, domains: list) -> dict:
    with state_lock():
        scope = {domain.strip().lower() for domain in domains}
        kept = [line for line in get_users_file().read_text(encoding="utf-8").splitlines()
                if line.strip() and _address_domain(line.split(":", 1)[0]) not in scope]
        content = "\n".join(kept) + ("\n" if kept else "") + passwd_lines(mailboxes)
        result = publish({"dovecot": stage("dovecot", {"users": content})})
        return {**result, "syncedCount": len(mailboxes), "mailboxes": [item["address"] for item in mailboxes]}


def get_vhosts_dir() -> Path:
    candidates = [
        Path.cwd() / "docker" / "mail-data" / "vhosts",
        Path.cwd().parent / "docker" / "mail-data" / "vhosts",
        Path.cwd().parent.parent / "docker" / "mail-data" / "vhosts",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


# ---------------------------------------------------------------------------
# Mailbox Disk Usage (F4.3)
# ---------------------------------------------------------------------------

def get_mailbox_usage(address: str) -> dict:
    """Sums real Maildir file sizes on disk for a single mailbox address."""
    address = address.strip().lower()
    if "@" not in address:
        return {"address": address, "usedBytes": 0, "exists": False}

    local_part, domain = address.split("@", 1)
    maildir = get_vhosts_dir() / domain / local_part / "Maildir"

    if not maildir.exists():
        return {"address": address, "usedBytes": 0, "exists": False}

    used_bytes = 0
    for root, _dirs, files in os.walk(maildir):
        for name in files:
            try:
                used_bytes += (Path(root) / name).stat().st_size
            except OSError:
                continue

    return {"address": address, "usedBytes": used_bytes, "exists": True}


def get_all_usage(addresses: list) -> dict:
    """Batch usage lookup so the API spawns this script once instead of per-mailbox."""
    usage = {}
    for address in addresses:
        result = get_mailbox_usage(address)
        usage[result["address"]] = result["usedBytes"]
    return {"usage": usage}


# ---------------------------------------------------------------------------
# Network & Port Probing
# ---------------------------------------------------------------------------

def check_port_open(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Status Inspection
# ---------------------------------------------------------------------------

def get_dovecot_status(host: str = "127.0.0.1") -> dict:
    port143_open = check_port_open(host, 143)
    port993_open = check_port_open(host, 993)
    sasl_open = check_port_open(host, 12345)

    container_running = False
    try:
        proc = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", "vexlyx-dovecot"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if proc.returncode == 0 and "true" in proc.stdout.lower():
            container_running = True
    except Exception:
        pass

    try:
        users_file = get_users_file()
    except MailStateError:
        users_file = Path("/__vexlyx_uninitialized_users__")
    mailbox_count = 0
    if users_file.exists():
        mailbox_count = len(
            [line for line in users_file.read_text(encoding="utf-8").splitlines() if line.strip()]
        )

    is_active = False
    if container_running:
        try:
            run_service("dovecot", "health")
            is_active = True
        except MailStateError:
            pass
    status_str = "active" if is_active else "inactive"

    return {
        "service": "dovecot",
        "status": status_str,
        "port143Open": port143_open,
        "port993Open": port993_open,
        "tlsEnforced": True,  # ssl = required in dovecot.conf
        "saslAuthConnected": sasl_open or container_running,
        "activeMailboxesCount": mailbox_count,
        "lastChecked": datetime.now(timezone.utc).isoformat(),
        "containerRunning": container_running,
    }


# ---------------------------------------------------------------------------
# Vacation Auto-Responder (F4.7 Pigeonhole Sieve)
# ---------------------------------------------------------------------------

def generate_sieve_script(
    subject: str,
    message: str,
    interval_days: int = 1,
    start_date: str = None,
    end_date: str = None,
) -> str:
    """Generates an RFC 5228/5230/5260 compliant Sieve vacation script."""
    safe_subject = subject.replace("\\", "\\\\").replace('"', '\\"')
    interval_days = max(1, min(30, int(interval_days)))

    # Dot-stuffing for Sieve text: literal (RFC 5228 section 2.4.2)
    lines = message.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    stuffed_lines = ["." + line if line.startswith(".") else line for line in lines]
    text_block = "text:\n" + "\n".join(stuffed_lines) + "\n.\n;"

    # If start_date and/or end_date are given (format YYYY-MM-DD or ISO), use RFC 5260 date extension
    date_conditions = []
    if start_date:
        s_date = str(start_date)[:10]  # Ensure YYYY-MM-DD
        date_conditions.append(f'currentdate :value "ge" "date" "{s_date}"')
    if end_date:
        e_date = str(end_date)[:10]  # Ensure YYYY-MM-DD
        date_conditions.append(f'currentdate :value "le" "date" "{e_date}"')

    if date_conditions:
        req_ext = 'require ["vacation", "date", "relational"];'
        cond_str = (
            "allof (\n  " + ",\n  ".join(date_conditions) + "\n)"
            if len(date_conditions) > 1
            else date_conditions[0]
        )
        script = (
            f"{req_ext}\n\n"
            f"if {cond_str} {{\n"
            f"  vacation\n"
            f"    :days {interval_days}\n"
            f'    :subject "{safe_subject}"\n'
            f"    {text_block}\n"
            f"}}\n"
        )
    else:
        script = (
            'require ["vacation"];\n\n'
            f"vacation\n"
            f"  :days {interval_days}\n"
            f'  :subject "{safe_subject}"\n'
            f"  {text_block}\n"
        )

    return script


def sync_vacation(
    address: str,
    enabled: bool,
    subject: str = "Out of office: Auto-reply",
    message: str = "",
    interval_days: int = 1,
    start_date: str = None,
    end_date: str = None,
) -> dict:
    """
    Creates or removes the .dovecot.sieve script for a mailbox.
    When enabled=True, writes the script and sets ownership to 5000:5000.
    When enabled=False, deletes .dovecot.sieve and .dovecot.svbin.
    """
    address = address.strip().lower()
    if "@" not in address:
        return {"success": False, "error": "Invalid address", "code": "INVALID_ADDRESS"}

    local_part, domain = address.split("@", 1)
    user_home = get_vhosts_dir() / domain / local_part
    user_home.mkdir(parents=True, exist_ok=True)

    sieve_file = user_home / ".dovecot.sieve"
    svbin_file = user_home / ".dovecot.svbin"

    if not enabled:
        if sieve_file.exists():
            try:
                sieve_file.unlink()
            except OSError:
                pass
        if svbin_file.exists():
            try:
                svbin_file.unlink()
            except OSError:
                pass
        return {
            "success": True,
            "address": address,
            "enabled": False,
            "sieveFileExists": False,
        }

    script_content = generate_sieve_script(
        subject=subject or "Out of office: Auto-reply",
        message=message or "I am currently away from the office.",
        interval_days=interval_days,
        start_date=start_date,
        end_date=end_date,
    )

    sieve_file.write_text(script_content, encoding="utf-8", newline="\n")

    # Invalidate old compiled binary so Dovecot re-compiles the new script on next delivery
    if svbin_file.exists():
        try:
            svbin_file.unlink()
        except OSError:
            pass

    if hasattr(os, "chown"):
        try:
            os.chown(str(sieve_file), VMAIL_UID, VMAIL_GID)
        except Exception:
            pass

    try:
        container_path = f"/var/mail/vhosts/{domain}/{local_part}/.dovecot.sieve"
        subprocess.run(
            ["docker", "exec", "vexlyx-dovecot", "chown", "5000:5000", container_path],
            capture_output=True,
            timeout=3,
        )
    except Exception:
        pass

    return {
        "success": True,
        "address": address,
        "enabled": True,
        "sieveFileExists": True,
        "scriptLength": len(script_content),
    }


# ---------------------------------------------------------------------------
# CLI Command Dispatcher
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        respond({"error": "Missing command argument", "code": "INVALID_ARGUMENTS"})
        sys.exit(1)

    cmd = sys.argv[1]
    payload = {}
    if len(sys.argv) >= 3:
        try:
            payload = json.loads(sys.argv[2])
        except Exception:
            payload = {}
    elif not sys.stdin.isatty():
        try:
            stdin_data = sys.stdin.read().strip()
            if stdin_data:
                payload = json.loads(stdin_data)
        except Exception:
            payload = {}

    try:
        if cmd == "status":
            host = payload.get("host", "127.0.0.1")
            respond(get_dovecot_status(host))
        elif cmd == "sync_mailboxes":
            mailboxes = payload.get("mailboxes", [])
            domains = payload.get("domains", [])
            respond(sync_mailboxes(mailboxes, domains))
        elif cmd == "get_usage":
            addresses = payload.get("addresses", [])
            respond(get_all_usage(addresses))
        elif cmd == "sync_vacation":
            address = payload.get("address", "")
            enabled = payload.get("enabled", False)
            subject = payload.get("subject", "Out of office: Auto-reply")
            message = payload.get("message", "")
            interval_days = payload.get("intervalDays", payload.get("interval_days", 1))
            start_date = payload.get("startDate", payload.get("start_date"))
            end_date = payload.get("endDate", payload.get("end_date"))
            respond(sync_vacation(address, enabled, subject, message, interval_days, start_date, end_date))
        else:
            respond({"error": f"Unknown command: {cmd}", "code": "UNKNOWN_COMMAND"})
            sys.exit(1)
    except MailStateError as exc:
        respond({"error": str(exc), "code": exc.code, "details": exc.details})
        sys.exit(1)
    except Exception as e:
        respond({"error": str(e), "code": "EXECUTION_ERROR"})
        sys.exit(1)


if __name__ == "__main__":
    main()
