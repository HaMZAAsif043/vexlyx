#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import uuid


LEGACY_FILES = (
    "docker/postfix/config/virtual_domains",
    "docker/postfix/config/virtual_mailbox_maps",
    "docker/postfix/config/virtual_alias_maps",
    "docker/dovecot/config/users",
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content if isinstance(content, bytes) else content.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def migrate(source, root):
    source, root = source.resolve(), root.resolve()
    if root == Path(root.anchor) or root in source.parents or source == root or source in root.parents and root != source / "docker" / "mail-data" / "state":
        raise ValueError("Production mail state must be outside the checkout; only the ignored development state path is allowed inside it.")
    root.mkdir(parents=True, exist_ok=True, mode=0o750)
    marker = root / ".migration.json"
    legacy = [source / name for name in LEGACY_FILES if (source / name).is_file()]
    dkim = source / "docker/postfix/opendkim"
    if dkim.exists():
        for path in dkim.rglob("*"):
            if path.is_symlink():
                raise ValueError("Legacy DKIM state contains a symlink; resolve it before migration.")
            if path.is_file() and path.name != "opendkim.conf":
                legacy.append(path)
    checksums = {str(path.relative_to(source)).replace("\\", "/"): digest(path) for path in legacy}
    previous = json.loads(marker.read_text()) if marker.exists() else {}
    backup = previous.get("backup")
    if legacy and checksums != previous.get("checksums"):
        backup_path = root / "legacy-backups" / uuid.uuid4().hex
        backup_path.mkdir(parents=True, mode=0o700)
        for path in legacy:
            destination = backup_path / path.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(path, destination)
            os.chmod(destination, 0o600)
            if digest(destination) != digest(path):
                raise ValueError("Legacy mail state changed during backup. Stop API writers and retry.")
        atomic_write(backup_path / "checksums.json", json.dumps(checksums, sort_keys=True))
        backup = str(backup_path)
    for component in ("postfix", "dovecot"):
        directory = root / component
        directory.mkdir(exist_ok=True, mode=0o750 if component == "dovecot" else 0o755)
        if (directory / "active.conf").exists():
            continue
        generation = uuid.uuid4().hex
        files = directory / "generations" / generation
        files.mkdir(parents=True, mode=0o750 if component == "dovecot" else 0o755)
        container = f"/var/lib/vexlyx-mail/{component}/generations/{generation}"
        if component == "postfix":
            for name in ("virtual_domains", "virtual_mailbox_maps", "virtual_alias_maps"):
                old = source / "docker/postfix/config" / name
                atomic_write(files / name, old.read_bytes() if old.exists() else b"", 0o644)
            config = f"# generation:{generation}\nvirtual_mailbox_domains = {container}/virtual_domains\nvirtual_mailbox_maps = lmdb:{container}/virtual_mailbox_maps\nvirtual_alias_maps = lmdb:{container}/virtual_alias_maps\n"
        else:
            old = source / "docker/dovecot/config/users"
            atomic_write(files / "users", old.read_bytes() if old.exists() else b"", 0o640)
            config = f"# generation:{generation}\npassdb {{\n  driver = passwd-file\n  args = scheme=ARGON2ID username_format=%u {container}/users\n}}\nuserdb {{\n  driver = passwd-file\n  args = username_format=%u {container}/users\n}}\n"
        atomic_write(directory / "active.conf", config, 0o644)
    target_dkim = root / "opendkim"
    target_dkim.mkdir(exist_ok=True, mode=0o750)
    for path in legacy:
        if dkim not in path.parents:
            continue
        destination = target_dkim / path.relative_to(dkim)
        if destination.exists():
            if destination.read_bytes() != path.read_bytes() and not previous:
                raise ValueError("Existing runtime DKIM state differs from legacy state. Both are preserved; reconcile the verified backup before retrying.")
        else:
            atomic_write(destination, path.read_bytes(), 0o600 if path.suffix == ".private" else 0o640)
    for name in ("KeyTable", "SigningTable", "TrustedHosts"):
        path = target_dkim / name
        if not path.exists():
            atomic_write(path, "127.0.0.1\nlocalhost\n::1\n10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16\n" if name == "TrustedHosts" else "", 0o640)
    atomic_write(marker, json.dumps({"version": 1, "backup": backup, "checksums": checksums}, sort_keys=True))
    return {"success": True, "stateRoot": str(root), "backup": backup, "preservedFiles": len(legacy)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--state-root", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(migrate(args.source, args.state_root)))
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc), "code": "MAIL_STATE_MIGRATION_FAILED"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
