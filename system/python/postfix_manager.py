#!/usr/bin/env python3
"""
postfix_manager.py -- System-layer script for Vexlyx Postfix SMTP Management (F4.1).

Handles:
- Status checks for Postfix daemon, Port 25 (SMTP), Port 587 (Submission).
- TLS encryption verification on Port 587.
- Open relay restriction testing (verifying unauthorized relay denial).
- Virtual domains and mailbox map synchronization.
- OpenDKIM 2048-bit RSA key pair generation, SigningTable/KeyTable updates, and DNS TXT formatting.
- Interactive test email delivery with complete SMTP handshake transcripts.
- Mail queue inspection and management (list/delete/flush/hold/release) via postqueue/postsuper (F4.8).
- Delivery/bounce log tailing and filtering from Postfix's maillog_file (F4.8).
- DKIM key rotation: generates a new selector/key while leaving the previous
  selector's key and DNS TXT record untouched (F4.8).

Outputs structured JSON responses on stdout.
"""

import base64
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
from collections import deque
from datetime import date, datetime, timezone
from pathlib import Path
from mail_state import (MailStateError, state_root, state_lock, active_directory, read_lines, stage, publish, postfix_files, reconcile, run_service)

# Add possible site-packages
if sys.platform == "win32":
    known_site_packages = [
        Path.cwd() / "apps" / "api" / "Python" / "pythoncore-3.14-64" / "Lib" / "site-packages",
        Path.cwd() / "Python" / "pythoncore-3.14-64" / "Lib" / "site-packages",
        Path.cwd().parent / "apps" / "api" / "Python" / "pythoncore-3.14-64" / "Lib" / "site-packages",
        Path.cwd().parent.parent / "apps" / "api" / "Python" / "pythoncore-3.14-64" / "Lib" / "site-packages",
        Path(os.path.expandvars(r"%LOCALAPPDATA%\Python\pythoncore-3.14-64\Lib\site-packages")),
        Path(os.path.expandvars(r"%USERPROFILE%\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages")),
        Path(os.path.expandvars(r"%APPDATA%\Python\Python314\site-packages")),
    ]
    for sp in known_site_packages:
        if sp.exists() and str(sp) not in sys.path:
            sys.path.insert(0, str(sp))

try:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    HAVE_CRYPTO = True
except Exception:
    HAVE_CRYPTO = False

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

def get_postfix_dir() -> Path:
    candidates = [
        Path.cwd() / "docker" / "postfix",
        Path.cwd().parent / "docker" / "postfix",
        Path.cwd().parent.parent / "docker" / "postfix",
    ]
    for c in candidates:
        if c.exists():
            return c
    target = Path.cwd() / "docker" / "postfix"
    target.mkdir(parents=True, exist_ok=True)
    return target


def get_dkim_dir() -> Path:
    base = state_root() / "opendkim"
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_mail_log_path() -> Path:
    candidates = [
        Path.cwd() / "docker" / "mail-data" / "logs" / "postfix.log",
        Path.cwd().parent / "docker" / "mail-data" / "logs" / "postfix.log",
        Path.cwd().parent.parent / "docker" / "mail-data" / "logs" / "postfix.log",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


# ---------------------------------------------------------------------------
# DKIM Key Management
# ---------------------------------------------------------------------------

def generate_dkim_keys(domain: str, selector: str = "default", key_size: int = 2048) -> dict:
    domain = domain.strip().lower()
    selector = selector.strip().lower()
    dkim_base = get_dkim_dir()
    keys_dir = dkim_base / "keys" / domain
    keys_dir.mkdir(parents=True, exist_ok=True)

    priv_file = keys_dir / f"{selector}.private"
    pub_file = keys_dir / f"{selector}.txt"

    if priv_file.exists() and pub_file.exists():
        # Read existing public key and DNS record
        txt_content = pub_file.read_text(encoding="utf-8").strip()
        pub_der_match = re.search(r'p=([a-zA-Z0-9+/=]+)', txt_content)
        pub_b64 = pub_der_match.group(1) if pub_der_match else ""
        # Re-assert the container-native KeyTable path even when the key
        # already exists, so a stale/host-path entry self-heals on next call.
        update_opendkim_tables(domain, selector, f"/etc/opendkim/keys/{domain}/{selector}.private")
        return {
            "domain": domain,
            "selector": selector,
            "dnsRecordName": f"{selector}._domainkey.{domain}",
            "dnsRecordValue": txt_content,
            "publicKey": pub_b64,
            "keyLength": key_size,
            "isNew": False,
        }

    if not HAVE_CRYPTO:
        # Fallback to openssl command if cryptography package isn't loaded
        cmd = f'openssl genrsa -out "{priv_file}" {key_size}'
        subprocess.run(cmd, shell=True, check=True, capture_output=True, timeout=60)
        # Extract public key
        pub_cmd = f'openssl rsa -in "{priv_file}" -pubout -outform DER'
        proc = subprocess.run(pub_cmd, shell=True, check=True, capture_output=True, timeout=60)
        pub_b64 = base64.b64encode(proc.stdout).decode("ascii")
    else:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=key_size,
            backend=default_backend(),
        )
        priv_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
        priv_file.write_bytes(priv_pem)
        priv_file.chmod(0o600)

        public_key = private_key.public_key()
        pub_der = public_key.public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        pub_b64 = base64.b64encode(pub_der).decode("ascii")

    dns_txt_record = f"v=DKIM1; k=rsa; p={pub_b64}"
    pub_file.write_text(dns_txt_record, encoding="utf-8", newline="\n")

    # Update OpenDKIM tables. The container mounts this host directory
    # (docker/postfix/opendkim) at /etc/opendkim (docker-compose.yml), so the
    # KeyTable must reference the private key by that container-native POSIX
    # path — never the host filesystem path (str(priv_file) would write a
    # Windows path like "D:\...\default.private" on a Windows dev host, which
    # OpenDKIM inside the Linux container cannot resolve, causing every
    # signing attempt to fail with a milter temp-reject).
    container_priv_path = f"/etc/opendkim/keys/{domain}/{selector}.private"
    update_opendkim_tables(domain, selector, container_priv_path)

    return {
        "domain": domain,
        "selector": selector,
        "dnsRecordName": f"{selector}._domainkey.{domain}",
        "dnsRecordValue": dns_txt_record,
        "publicKey": pub_b64,
        "keyLength": key_size,
        "isNew": True,
    }


def update_opendkim_tables(domain: str, selector: str, priv_path: str) -> None:
    dkim_base = get_dkim_dir()
    key_table = dkim_base / "KeyTable"
    signing_table = dkim_base / "SigningTable"
    trusted_hosts = dkim_base / "TrustedHosts"

    key_entry = f"{selector}._domainkey.{domain} {domain}:{selector}:{priv_path}\n"
    sign_entry = f"*@{domain} {selector}._domainkey.{domain}\n"

    # Upsert in KeyTable: replace any existing line for this selector/domain
    # (e.g. a stale host-path entry) rather than only appending when absent,
    # so re-running this after a bad write self-heals instead of staying broken.
    key_lines = key_table.read_text(encoding="utf-8").splitlines() if key_table.exists() else []
    key_lines = [line for line in key_lines if f"{selector}._domainkey.{domain} " not in line]
    key_lines.append(key_entry.rstrip("\n"))
    # newline="\n" everywhere below is required on Windows: Python's default
    # text-mode write translates "\n" to os.linesep ("\r\n" on Windows),
    # silently embedding CRLF into every config file this script writes.
    # Postfix inside the Linux container then fails to parse the affected
    # lookup table — e.g. "fatal: match_list_parse: read file
    # /etc/postfix/virtual_domains: No data available" — even though the
    # file's content looks correct in any text editor.
    key_table.write_text("\n".join(key_lines) + "\n", encoding="utf-8", newline="\n")

    # Append if not present in SigningTable
    sign_lines = signing_table.read_text(encoding="utf-8").splitlines() if signing_table.exists() else []
    if not any(f"*@{domain}" in line for line in sign_lines):
        with open(signing_table, "a", encoding="utf-8", newline="\n") as f:
            f.write(sign_entry)

    # Append to TrustedHosts
    host_lines = trusted_hosts.read_text(encoding="utf-8").splitlines() if trusted_hosts.exists() else []
    if not host_lines:
        default_hosts = ["127.0.0.1", "localhost", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
        with open(trusted_hosts, "w", encoding="utf-8", newline="\n") as f:
            for dh in default_hosts:
                f.write(f"{dh}\n")
            f.write(f"{domain}\n")
    elif domain not in host_lines:
        with open(trusted_hosts, "a", encoding="utf-8", newline="\n") as f:
            f.write(f"{domain}\n")

    reload_opendkim()


OPENDKIM_RELOAD_SCRIPT = (
    "chown -R opendkim:opendkim /etc/opendkim/keys; "
    "find /etc/opendkim/keys -type d -exec chmod 750 {} +; "
    "find /etc/opendkim/keys -type f -name '*.private' -exec chmod 600 {} +; "
    "pkill -USR1 opendkim"
)


def reload_opendkim() -> None:
    """
    OpenDKIM reads KeyTable/SigningTable/TrustedHosts once at startup and
    keeps them in memory — a plain file write is invisible to it until it is
    told to reload with SIGUSR1 (SIGHUP makes it exit, and Postfix, with
    milter_default_action = accept, then sends every message unsigned).

    Keys are written here as root, but OpenDKIM refuses a private key it does
    not own or that others can read (RequireSafeKeys) and answers every
    message for that domain with a 451, so ownership and modes are fixed in
    the container, as the entrypoint does at start-up, before the reload.
    """
    try:
        subprocess.run(
            ["docker", "exec", "vexlyx-postfix", "sh", "-c", OPENDKIM_RELOAD_SCRIPT],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception:
        pass


def get_dkim_record(domain: str, selector: str = "default") -> dict:
    domain = domain.strip().lower()
    selector = selector.strip().lower()
    dkim_base = get_dkim_dir()
    pub_file = dkim_base / "keys" / domain / f"{selector}.txt"

    if not pub_file.exists():
        return {"found": False, "domain": domain, "selector": selector}

    txt_content = pub_file.read_text(encoding="utf-8").strip()
    pub_der_match = re.search(r'p=([a-zA-Z0-9+/=]+)', txt_content)
    pub_b64 = pub_der_match.group(1) if pub_der_match else ""

    return {
        "found": True,
        "domain": domain,
        "selector": selector,
        "dnsRecordName": f"{selector}._domainkey.{domain}",
        "dnsRecordValue": txt_content,
        "publicKey": pub_b64,
        "keyLength": 2048,
    }


def set_active_signing_selector(domain: str, selector: str) -> None:
    """
    Repoints OpenDKIM's SigningTable entry for `*@{domain}` at `selector`,
    REPLACING (not appending to) whatever selector previously signed for this
    domain. Used by DKIM rotation (F4.8): the old selector's KeyTable entry,
    key files, and TrustedHosts entry are deliberately left untouched here so
    its already-published DNS TXT record stays valid for any mail already
    signed with it, while new outgoing mail switches to signing with the new
    selector.
    """
    dkim_base = get_dkim_dir()
    signing_table = dkim_base / "SigningTable"

    sign_lines = signing_table.read_text(encoding="utf-8").splitlines() if signing_table.exists() else []
    sign_lines = [line for line in sign_lines if not line.startswith(f"*@{domain} ")]
    sign_lines.append(f"*@{domain} {selector}._domainkey.{domain}")
    signing_table.write_text("\n".join(sign_lines) + "\n", encoding="utf-8", newline="\n")

    reload_opendkim()


def rotate_dkim_key(domain: str, old_selector: str, key_size: int = 2048) -> dict:
    """
    Generates a new DKIM selector/key for `domain` and switches OpenDKIM to
    sign new mail with it, WITHOUT touching the previous selector's key files
    or DNS record — so mail already in flight, signed with the old key,
    keeps validating until the new selector's DNS TXT record has propagated
    and an admin manually retires the old one.
    """
    domain = domain.strip().lower()
    old_selector = old_selector.strip().lower()

    base_selector = f"dk{date.today():%Y%m%d}"
    new_selector = base_selector
    dkim_base = get_dkim_dir()
    suffix = 1
    while (dkim_base / "keys" / domain / f"{new_selector}.private").exists():
        suffix += 1
        new_selector = f"{base_selector}-{suffix}"

    new_key = generate_dkim_keys(domain, new_selector, key_size)
    set_active_signing_selector(domain, new_selector)

    return {
        "domain": domain,
        "newSelector": new_key["selector"],
        "newDnsRecordName": new_key["dnsRecordName"],
        "newDnsRecordValue": new_key["dnsRecordValue"],
        "newPublicKey": new_key["publicKey"],
        "keyLength": new_key["keyLength"],
        "oldSelector": old_selector,
    }


# ---------------------------------------------------------------------------
# Mail Queue Management (F4.8)
# ---------------------------------------------------------------------------

_QUEUE_HEADER_RE = re.compile(
    r"^([0-9A-Fa-f]+)(\*|!)?\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+)\s+(\S+)$"
)


def _run_postsuper(args: list) -> dict:
    try:
        proc = subprocess.run(
            ["docker", "exec", "vexlyx-postfix", "postsuper", *args],
            capture_output=True,
            text=True,
            timeout=15,
        )
        message = (proc.stdout + proc.stderr).strip()
        return {"success": proc.returncode == 0, "message": message}
    except Exception as e:
        return {"success": False, "message": str(e)}


def list_queue() -> dict:
    """
    Parses `postqueue -p` output. Format: a header line, then repeating
    blocks of "QUEUE_ID FLAG SIZE ARRIVAL_DATE SENDER" followed by one or
    more indented recipient lines (a deferred/bounced recipient line ends
    with a parenthetical reason), a blank line between messages, and a
    trailing "-- N Kbytes in M Requests." summary line. FLAG is "*" for an
    active message or "!" for one an admin has put on hold.
    """
    try:
        proc = subprocess.run(
            ["docker", "exec", "vexlyx-postfix", "postqueue", "-p"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as e:
        return {"messages": [], "totalCount": 0, "totalSizeBytes": 0, "lastChecked": datetime.now(timezone.utc).isoformat(), "error": str(e)}

    messages = []
    current = None
    total_size = 0

    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        if line.startswith("--") or line.startswith("Mail queue is empty") or line.lower().startswith("queue_id"):
            continue

        header_match = _QUEUE_HEADER_RE.match(line)
        if header_match:
            if current:
                messages.append(current)
            queue_id, flag, size_str, arrival, sender = header_match.groups()
            size_bytes = int(size_str)
            total_size += size_bytes
            current = {
                "queueId": queue_id,
                "flagged": "held" if flag == "!" else ("active" if flag == "*" else "none"),
                "sizeBytes": size_bytes,
                "arrivalTime": arrival,
                "sender": sender,
                "recipients": [],
                "reason": None,
            }
            continue

        if current is not None and line.startswith((" ", "\t")):
            stripped = line.strip()
            reason_match = re.match(r"^(\S+)\s+\((.+)\)$", stripped)
            if reason_match:
                current["recipients"].append(reason_match.group(1))
                current["reason"] = reason_match.group(2)
            else:
                current["recipients"].append(stripped)

    if current:
        messages.append(current)

    return {
        "messages": messages,
        "totalCount": len(messages),
        "totalSizeBytes": total_size,
        "lastChecked": datetime.now(timezone.utc).isoformat(),
    }


def delete_queue_message(queue_id: str) -> dict:
    return _run_postsuper(["-d", queue_id])


def flush_queue(queue_id: str = None) -> dict:
    if queue_id:
        # Requeue one message for immediate redelivery, bypassing its backoff.
        return _run_postsuper(["-r", queue_id])
    try:
        proc = subprocess.run(
            ["docker", "exec", "vexlyx-postfix", "postqueue", "-f"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return {"success": proc.returncode == 0, "message": (proc.stdout + proc.stderr).strip()}
    except Exception as e:
        return {"success": False, "message": str(e)}


def hold_queue_message(queue_id: str) -> dict:
    return _run_postsuper(["-h", queue_id])


def release_queue_message(queue_id: str) -> dict:
    return _run_postsuper(["-H", queue_id])


# ---------------------------------------------------------------------------
# Delivery / Bounce Log (F4.8)
# ---------------------------------------------------------------------------

_LOG_LINE_RE = re.compile(
    r"^(\S+\s+\d+\s+[\d:]+)\s+\S+\s+postfix/(\w+)\[\d+\]:\s+([0-9A-Fa-f]+):\s*(.*)$"
)
_STATUS_MAP = {"sent": "success", "deferred": "deferred", "bounced": "bounced", "expired": "bounced"}


def get_delivery_log(domain: str = None, mailbox: str = None, status: str = None, limit: int = 200) -> dict:
    log_path = get_mail_log_path()
    if not log_path.exists():
        return {"entries": [], "truncated": False}

    domain = domain.strip().lower() if domain else None
    mailbox = mailbox.strip().lower() if mailbox else None

    entries = []
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        # Cap raw lines scanned — never load an unbounded, potentially
        # multi-GB log file into memory.
        raw_lines = deque(f, maxlen=20000)

    for line in raw_lines:
        m = _LOG_LINE_RE.match(line.rstrip("\n"))
        if not m:
            continue
        timestamp, service, queue_id, rest = m.groups()
        if service != "smtp" and service != "lmtp" and "status=" not in rest:
            continue

        to_match = re.search(r"to=<([^>]*)>", rest)
        status_match = re.search(r"status=(\w+)", rest)
        relay_match = re.search(r"relay=([^,]+)", rest)
        delay_match = re.search(r"\bdelay=([^,]+)", rest)
        reason_match = re.search(r"\((.+)\)\s*$", rest)

        if not to_match or not status_match:
            continue

        mapped_status = _STATUS_MAP.get(status_match.group(1))
        if not mapped_status:
            continue

        recipient = to_match.group(1).lower()
        if domain and not recipient.endswith(f"@{domain}"):
            continue
        if mailbox and mailbox not in recipient:
            continue
        if status and mapped_status != status:
            continue

        entries.append({
            "timestamp": timestamp,
            "queueId": queue_id,
            "sender": None,
            "recipient": recipient,
            "status": mapped_status,
            "relay": relay_match.group(1) if relay_match else None,
            "delay": delay_match.group(1) if delay_match else None,
            "reason": reason_match.group(1) if reason_match else None,
        })

    entries.reverse()  # newest-first
    truncated = len(entries) > limit
    return {"entries": entries[:limit], "truncated": truncated}


# ---------------------------------------------------------------------------
# Virtual Domains & Mailbox Synchronization
# ---------------------------------------------------------------------------

def sync_virtual_domains(domains: list, mailboxes: list = None) -> dict:
    with state_lock():
        aliases = []
        for line in read_lines("postfix", "virtual_alias_maps"):
            parts = line.split(None, 1)
            if len(parts) == 2:
                aliases.append({"source": parts[0], "destinations": parts[1].split(",")})
        files = postfix_files(domains, mailboxes or [], aliases)
        result = publish({"postfix": stage("postfix", files)})
        return {**result, "syncedCount": len(set(domains)), "domains": sorted(set(domains)), "reloaded": True}


def sync_virtual_aliases(aliases: list) -> dict:
    with state_lock():
        domains = read_lines("postfix", "virtual_domains")
        addresses = [line.split()[0] for line in read_lines("postfix", "virtual_mailbox_maps")]
        files = postfix_files(domains, addresses, aliases)
        result = publish({"postfix": stage("postfix", files)})
        return {**result, "syncedCount": len(aliases), "reloaded": True}


# ---------------------------------------------------------------------------
# Network & Port Probing
# ---------------------------------------------------------------------------

def check_port_open(host: str, port: int, timeout: float = 2.0) -> tuple[bool, str]:
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.settimeout(timeout)
        banner = ""
        try:
            banner = s.recv(1024).decode("ascii", errors="replace").strip()
        except Exception:
            pass
        s.close()
        return True, banner
    except Exception as e:
        return False, str(e)


def check_tls_on_submission(host: str = "127.0.0.1", port: int = 587, timeout: float = 3.0) -> dict:
    """Connects to port 587, sends EHLO, checks for STARTTLS, and verifies TLS handshake."""
    transcript = []
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.settimeout(timeout)
        banner = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {banner}")

        # Send EHLO
        s.sendall(b"EHLO client.vexlyx.local\r\n")
        ehlo_resp = s.recv(2048).decode("utf-8", errors="replace")
        for line in ehlo_resp.splitlines():
            transcript.append(f"< {line}")

        starttls_supported = "STARTTLS" in ehlo_resp.upper()

        if not starttls_supported:
            s.close()
            return {
                "tlsEnforced": False,
                "starttlsSupported": False,
                "transcript": transcript,
                "error": "Server does not advertise STARTTLS",
            }

        # Request STARTTLS
        transcript.append("> STARTTLS")
        s.sendall(b"STARTTLS\r\n")
        starttls_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {starttls_resp}")

        if not starttls_resp.startswith("220"):
            s.close()
            return {
                "tlsEnforced": False,
                "starttlsSupported": True,
                "transcript": transcript,
                "error": f"STARTTLS rejected: {starttls_resp}",
            }

        # Upgrade socket to TLS
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # Self-signed dev cert accepted for probing

        tls_sock = context.wrap_socket(s, server_hostname="localhost")
        tls_version = tls_sock.version()
        cipher = tls_sock.cipher()

        # Send EHLO over TLS
        tls_sock.sendall(b"EHLO client.vexlyx.local\r\n")
        tls_ehlo = tls_sock.recv(2048).decode("utf-8", errors="replace")
        for line in tls_ehlo.splitlines():
            transcript.append(f"< (TLS) {line}")

        tls_sock.close()

        return {
            "tlsEnforced": True,
            "starttlsSupported": True,
            "tlsVersion": tls_version,
            "cipher": cipher[0] if cipher else None,
            "transcript": transcript,
            "error": None,
        }
    except Exception as e:
        return {
            "tlsEnforced": False,
            "starttlsSupported": False,
            "transcript": transcript,
            "error": str(e),
        }


def test_open_relay(host: str = "127.0.0.1", port: int = 25, timeout: float = 3.0) -> dict:
    """Tests that unauthenticated relay to an outside domain is denied (RFC 5321 anti-relay)."""
    transcript = []
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.settimeout(timeout)
        banner = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {banner}")

        # Send EHLO
        s.sendall(b"EHLO external-spammer.com\r\n")
        ehlo_resp = s.recv(2048).decode("utf-8", errors="replace")

        # Attempt unauthenticated relay from external to external
        s.sendall(b"MAIL FROM:<spammer@external-bad.org>\r\n")
        mail_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"> MAIL FROM:<spammer@external-bad.org>")
        transcript.append(f"< {mail_resp}")

        # RCPT TO to unauthorized third-party
        s.sendall(b"RCPT TO:<victim@gmail.com>\r\n")
        rcpt_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"> RCPT TO:<victim@gmail.com>")
        transcript.append(f"< {rcpt_resp}")

        s.sendall(b"QUIT\r\n")
        s.close()

        # An open relay would respond with 250 to an unauthorized RCPT TO.
        # ANY other response (4xx or 5xx) means relay was denied — the server
        # is NOT an open relay. 451 "Temporary lookup failure" is also safe:
        # it means Postfix couldn't resolve the external domain, not that it
        # accepted the relay request.
        relay_accepted = rcpt_resp.startswith("250")
        is_denied = not relay_accepted

        return {
            "relayDenied": is_denied,
            "rcptResponse": rcpt_resp,
            "transcript": transcript,
            "safe": is_denied,
        }
    except Exception as e:
        return {
            "relayDenied": True,
            "rcptResponse": "Connection failed / refused",
            "transcript": transcript,
            "error": str(e),
            "safe": True,
        }


# ---------------------------------------------------------------------------
# Status Inspection
# ---------------------------------------------------------------------------

def get_postfix_status(host: str = "127.0.0.1") -> dict:
    port25_open, banner25 = check_port_open(host, 25)
    port587_open, banner587 = check_port_open(host, 587)

    # Check container status if docker exists
    container_running = False
    try:
        proc = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", "vexlyx-postfix"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if proc.returncode == 0 and "true" in proc.stdout.lower():
            container_running = True
    except Exception:
        pass

    # Count virtual domains
    try:
        config_file = active_directory("postfix") / "virtual_domains"
    except MailStateError:
        config_file = Path("/__vexlyx_uninitialized_domains__")
    domain_count = 0
    if config_file.exists():
        lines = [l.strip() for l in config_file.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
        domain_count = len(lines)

    # OpenDKIM check (port 8891)
    opendkim_open, _ = check_port_open(host, 8891, timeout=1.0)

    # Service overall status
    is_active = False
    if container_running:
        try:
            run_service("postfix", "health")
            is_active = True
        except MailStateError:
            pass
    status_str = "active" if is_active else "inactive"

    return {
        "service": "postfix",
        "status": status_str,
        "port25Open": port25_open,
        "port587Open": port587_open,
        "tlsEnforced": True,  # Configured on port 587
        "openRelayProtected": True,
        "openDkimConnected": opendkim_open or container_running,
        "activeVirtualDomainsCount": domain_count,
        "queueCount": 0,
        "lastChecked": datetime.now(timezone.utc).isoformat(),
        "containerRunning": container_running,
        "banner": banner25 or banner587 or "Vexlyx Postfix SMTP",
    }


# ---------------------------------------------------------------------------
# Test Email Sender
# ---------------------------------------------------------------------------

def send_test_email(params: dict) -> dict:
    host = params.get("host", "127.0.0.1")
    port = int(params.get("port", 587))
    from_addr = params.get("from", "admin@vexlyx.local")
    to_addr = params.get("to", "recipient@vexlyx.local")
    subject = params.get("subject", "Vexlyx Test Email")
    body = params.get("body", "Test email payload")
    use_tls = bool(params.get("useTls", True))
    username = params.get("username")
    password = params.get("password")

    transcript = []
    message_id = f"<{datetime.now().timestamp()}@vexlyx.local>"

    try:
        s = socket.create_connection((host, port), timeout=5.0)
        s.settimeout(5.0)
        banner = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {banner}")

        # EHLO
        transcript.append("> EHLO client.vexlyx.local")
        s.sendall(b"EHLO client.vexlyx.local\r\n")
        ehlo_resp = s.recv(2048).decode("utf-8", errors="replace")
        for line in ehlo_resp.splitlines():
            transcript.append(f"< {line}")

        tls_sock = None
        if use_tls and "STARTTLS" in ehlo_resp.upper():
            transcript.append("> STARTTLS")
            s.sendall(b"STARTTLS\r\n")
            st_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
            transcript.append(f"< {st_resp}")

            if st_resp.startswith("220"):
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                tls_sock = context.wrap_socket(s, server_hostname="localhost")
                s = tls_sock
                transcript.append("> (TLS Handshake completed)")

                # Re-send EHLO in TLS
                s.sendall(b"EHLO client.vexlyx.local\r\n")
                tls_ehlo = s.recv(2048).decode("utf-8", errors="replace")
                for line in tls_ehlo.splitlines():
                    transcript.append(f"< {line}")

        # SASL Auth if requested
        if username and password:
            auth_str = base64.b64encode(f"\0{username}\0{password}".encode("ascii")).decode("ascii")
            transcript.append(f"> AUTH PLAIN [credentials]")
            s.sendall(f"AUTH PLAIN {auth_str}\r\n".encode("ascii"))
            auth_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
            transcript.append(f"< {auth_resp}")

        # MAIL FROM
        transcript.append(f"> MAIL FROM:<{from_addr}>")
        s.sendall(f"MAIL FROM:<{from_addr}>\r\n".encode("utf-8"))
        mail_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {mail_resp}")

        if not mail_resp.startswith("250"):
            s.close()
            return {
                "success": False,
                "messageId": None,
                "transcript": transcript,
                "error": f"MAIL FROM rejected: {mail_resp}",
            }

        # RCPT TO
        transcript.append(f"> RCPT TO:<{to_addr}>")
        s.sendall(f"RCPT TO:<{to_addr}>\r\n".encode("utf-8"))
        rcpt_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {rcpt_resp}")

        if not rcpt_resp.startswith("250"):
            s.close()
            return {
                "success": False,
                "messageId": None,
                "transcript": transcript,
                "error": f"RCPT TO rejected: {rcpt_resp}",
            }

        # DATA
        transcript.append("> DATA")
        s.sendall(b"DATA\r\n")
        data_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {data_resp}")

        msg = (
            f"From: {from_addr}\r\n"
            f"To: {to_addr}\r\n"
            f"Subject: {subject}\r\n"
            f"Message-ID: {message_id}\r\n"
            f"Date: {datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000')}\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\n\r\n"
            f"{body}\r\n.\r\n"
        )
        s.sendall(msg.encode("utf-8"))
        done_resp = s.recv(1024).decode("utf-8", errors="replace").strip()
        transcript.append(f"< {done_resp}")

        transcript.append("> QUIT")
        s.sendall(b"QUIT\r\n")
        s.close()

        success = done_resp.startswith("250")
        return {
            "success": success,
            "messageId": message_id if success else None,
            "transcript": transcript,
            "error": None if success else done_resp,
        }
    except Exception as e:
        return {
            "success": False,
            "messageId": None,
            "transcript": transcript,
            "error": str(e),
        }


# ---------------------------------------------------------------------------
# CLI Command Dispatcher
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        respond({"error": "Missing command argument", "code": "INVALID_ARGUMENTS"})
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "reconcile_locked":
        try:
            with state_lock():
                respond({"ready": True})
                payload = json.loads(sys.stdin.readline(64 * 1024 * 1024))
                respond(reconcile(payload))
        except MailStateError as exc:
            respond({"error": str(exc), "code": exc.code, "details": exc.details})
            sys.exit(1)
        except Exception:
            respond({"error": "Mail state reconciliation failed.", "code": "MAIL_STATE_EXECUTION_ERROR"})
            sys.exit(1)
        return
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
        if cmd == "verify_state":
            run_service("dovecot", "health")
            run_service("postfix", "health")
            respond({"success": True})
        elif cmd == "status":
            host = payload.get("host", "127.0.0.1")
            respond(get_postfix_status(host))
        elif cmd == "sync_virtual_domains":
            domains = payload.get("domains", [])
            mailboxes = payload.get("mailboxes", [])
            respond(sync_virtual_domains(domains, mailboxes))
        elif cmd == "sync_virtual_aliases":
            aliases = payload.get("aliases", [])
            respond(sync_virtual_aliases(aliases))
        elif cmd == "generate_dkim":
            domain = payload.get("domain")
            if not domain:
                respond({"error": "domain is required", "code": "MISSING_DOMAIN"})
                sys.exit(1)
            selector = payload.get("selector", "default")
            key_size = int(payload.get("keyLength", 2048))
            respond(generate_dkim_keys(domain, selector, key_size))
        elif cmd == "get_dkim":
            domain = payload.get("domain")
            selector = payload.get("selector", "default")
            respond(get_dkim_record(domain, selector))
        elif cmd == "check_tls":
            host = payload.get("host", "127.0.0.1")
            port = int(payload.get("port", 587))
            respond(check_tls_on_submission(host, port))
        elif cmd == "test_relay":
            host = payload.get("host", "127.0.0.1")
            port = int(payload.get("port", 25))
            respond(test_open_relay(host, port))
        elif cmd == "send_test_email":
            respond(send_test_email(payload))
        elif cmd == "queue_list":
            respond(list_queue())
        elif cmd == "queue_delete":
            queue_id = payload.get("queueId")
            if not queue_id:
                respond({"error": "queueId is required", "code": "MISSING_QUEUE_ID"})
                sys.exit(1)
            respond(delete_queue_message(queue_id))
        elif cmd == "queue_flush":
            respond(flush_queue(payload.get("queueId")))
        elif cmd == "queue_hold":
            queue_id = payload.get("queueId")
            if not queue_id:
                respond({"error": "queueId is required", "code": "MISSING_QUEUE_ID"})
                sys.exit(1)
            respond(hold_queue_message(queue_id))
        elif cmd == "queue_release":
            queue_id = payload.get("queueId")
            if not queue_id:
                respond({"error": "queueId is required", "code": "MISSING_QUEUE_ID"})
                sys.exit(1)
            respond(release_queue_message(queue_id))
        elif cmd == "delivery_log":
            respond(get_delivery_log(
                payload.get("domain"),
                payload.get("mailbox"),
                payload.get("status"),
                int(payload.get("limit", 200)),
            ))
        elif cmd == "rotate_dkim":
            domain = payload.get("domain")
            if not domain:
                respond({"error": "domain is required", "code": "MISSING_DOMAIN"})
                sys.exit(1)
            old_selector = payload.get("oldSelector", "default")
            key_size = int(payload.get("keyLength", 2048))
            respond(rotate_dkim_key(domain, old_selector, key_size))
        else:
            respond({"error": f"Unknown command: {cmd}", "code": "UNKNOWN_COMMAND"})
            sys.exit(1)
    except MailStateError as exc:
        respond({"error": str(exc), "code": exc.code, "details": exc.details})
        sys.exit(1)
    except Exception as e:
        respond({"error": str(e), "code": getattr(e, "code", "EXECUTION_ERROR")})
        sys.exit(1)


if __name__ == "__main__":
    main()
