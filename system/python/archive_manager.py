#!/usr/bin/env python3
"""
archive_manager.py — archive extract / compress for the Vexlyx File Manager.

All communication via stdin (JSON) -> stdout (JSON). Uses only the Python
standard library (zipfile / tarfile), so no extra binary is required on the
host.

Commands (the "command" field of the JSON payload):
  extract    Unpack a .zip / .tar / .tar.gz / .tar.bz2 archive
  compress   Pack files and folders into a .zip

The caller (apps/api files module) has already resolved every path against the
project root. This script re-validates everything anyway: an archive is
untrusted input, so no entry is written until the whole archive has been
scanned, and extraction goes through a staging directory.
"""

import zlib
import json
import os
import re
import secrets
import shutil
import stat
import sys
import tarfile
import time
import zipfile
from pathlib import PurePosixPath

COPY_CHUNK = 1024 * 1024
STAGING_PREFIX = ".vexlyx-extract-"

# Mirrors BLOCKED_WRITE_PATTERNS in apps/api/src/modules/files/schema.ts: the
# File Manager never writes these names, so an archive must not be a way
# around that.
BLOCKED_WRITE_PATTERNS = [
    re.compile(r"^\.env(\..*)?$", re.IGNORECASE),
    re.compile(r"^wp-config\.php$", re.IGNORECASE),
]

ZIP_SYMLINK_MASK = 0o170000


class ArchiveError(Exception):
    def __init__(self, message: str, code: str = "ARCHIVE_ERROR"):
        super().__init__(message)
        self.message = message
        self.code = code


def ok(data: dict):
    print(json.dumps({"success": True, **data}), flush=True)
    sys.exit(0)


def fail(message: str, code: str = "ARCHIVE_ERROR"):
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)


class Deadline:
    """Wall-clock budget so a huge archive cannot run forever."""

    def __init__(self, seconds: float):
        self.limit = time.monotonic() + seconds

    def check(self):
        if time.monotonic() > self.limit:
            raise ArchiveError("Archive operation timed out", "ARCHIVE_TIMEOUT")


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def is_inside(child: str, parent: str) -> bool:
    child = os.path.realpath(child)
    parent = os.path.realpath(parent)
    return child == parent or child.startswith(parent + os.sep)


def clean_member_name(raw: str) -> str:
    """
    Normalise an archive entry name to a safe relative POSIX path.
    Raises ArchiveError for anything that could land outside the destination.
    """
    if "\0" in raw:
        raise ArchiveError("Archive entry contains a null byte", "UNSAFE_ARCHIVE")
    name = raw.replace("\\", "/")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ArchiveError(f'Archive entry "{raw}" uses an absolute path', "UNSAFE_ARCHIVE")
    parts = [p for p in PurePosixPath(name).parts if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ArchiveError(f'Archive entry "{raw}" escapes the destination', "UNSAFE_ARCHIVE")
    return "/".join(parts)


def is_blocked_name(rel: str) -> bool:
    base = rel.rsplit("/", 1)[-1]
    return any(p.match(base) for p in BLOCKED_WRITE_PATTERNS)


def safe_mode(mode: int, is_dir: bool) -> int:
    """Never trust archive permission bits: no setuid/setgid/sticky, no world-write."""
    if is_dir:
        return 0o755
    return 0o755 if mode & 0o100 else 0o644


# ---------------------------------------------------------------------------
# Entry model (format-agnostic view of an archive member)
# ---------------------------------------------------------------------------

class Entry:
    def __init__(self, name: str, is_dir: bool, size: int, mode: int, handle):
        self.name = name
        self.is_dir = is_dir
        self.size = size
        self.mode = mode
        self.handle = handle  # ZipInfo or TarInfo


def detect_format(filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith((".tar.gz", ".tgz")):
        return "tar.gz"
    if lower.endswith((".tar.bz2", ".tbz2", ".tbz")):
        return "tar.bz2"
    if lower.endswith(".tar"):
        return "tar"
    raise ArchiveError(
        "Unsupported archive type. Supported: .zip, .tar, .tar.gz, .tgz, .tar.bz2",
        "UNSUPPORTED_FORMAT",
    )


def list_zip_entries(zf: zipfile.ZipFile) -> list[Entry]:
    entries = []
    for info in zf.infolist():
        unix_mode = (info.external_attr >> 16) & 0xFFFF
        file_type = unix_mode & ZIP_SYMLINK_MASK
        if file_type == stat.S_IFLNK:
            raise ArchiveError(
                f'Archive contains a symbolic link ("{info.filename}")', "UNSAFE_ARCHIVE"
            )
        if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ArchiveError(
                f'Archive contains a special file ("{info.filename}")', "UNSAFE_ARCHIVE"
            )
        if info.flag_bits & 0x1:
            raise ArchiveError("Encrypted archives are not supported", "UNSUPPORTED_FORMAT")
        entries.append(Entry(info.filename, info.is_dir(), info.file_size, unix_mode, info))
    return entries


def list_tar_entries(tf: tarfile.TarFile) -> list[Entry]:
    entries = []
    for member in tf.getmembers():
        if member.issym() or member.islnk():
            raise ArchiveError(
                f'Archive contains a link ("{member.name}")', "UNSAFE_ARCHIVE"
            )
        if not (member.isreg() or member.isdir()):
            raise ArchiveError(
                f'Archive contains a special file ("{member.name}")', "UNSAFE_ARCHIVE"
            )
        entries.append(Entry(member.name, member.isdir(), member.size, member.mode, member))
    return entries


# ---------------------------------------------------------------------------
# extract
# ---------------------------------------------------------------------------

def open_archive(path: str, fmt: str):
    try:
        if fmt == "zip":
            return zipfile.ZipFile(path)
        modes = {"tar": "r:", "tar.gz": "r:gz", "tar.bz2": "r:bz2"}
        return tarfile.open(path, modes[fmt])
    except (zipfile.BadZipFile, tarfile.TarError, OSError, EOFError, zlib.error) as exc:
        raise ArchiveError(f"Archive is corrupt or unreadable: {exc}", "CORRUPT_ARCHIVE")


def validate_entries(entries: list[Entry], archive_size: int, limits: dict):
    """
    Scan the whole archive before anything touches the disk. Returns the list
    of (relative_name, entry) to write and the list of skipped names.
    """
    max_entries = limits["maxEntries"]
    max_bytes = limits["maxBytes"]
    max_ratio = limits["maxRatio"]

    if len(entries) > max_entries:
        raise ArchiveError(
            f"Archive has too many entries ({len(entries)} > {max_entries})", "ARCHIVE_TOO_LARGE"
        )

    total = 0
    to_write: list[tuple[str, Entry]] = []
    skipped: list[str] = []
    seen_kinds: dict[str, bool] = {}

    for entry in entries:
        rel = clean_member_name(entry.name)
        if not rel:
            continue
        if is_blocked_name(rel):
            skipped.append(rel)
            continue
        key = rel.lower()
        if key in seen_kinds and seen_kinds[key] != entry.is_dir:
            raise ArchiveError(
                f'Archive entry "{rel}" is both a file and a folder', "UNSAFE_ARCHIVE"
            )
        seen_kinds[key] = entry.is_dir
        total += max(entry.size, 0)
        to_write.append((rel, entry))

    if total > max_bytes:
        raise ArchiveError(
            f"Archive is too large when extracted ({total} > {max_bytes} bytes)",
            "ARCHIVE_TOO_LARGE",
        )
    if archive_size > 0 and total / archive_size > max_ratio:
        raise ArchiveError(
            "Archive compression ratio is suspiciously high (possible zip bomb)",
            "ARCHIVE_TOO_LARGE",
        )
    return to_write, skipped


def copy_member(src, dst_path: str, budget: dict, deadline: Deadline):
    """Stream one member to disk, counting real bytes (headers can lie)."""
    with open(dst_path, "wb") as out:
        while True:
            chunk = src.read(COPY_CHUNK)
            if not chunk:
                break
            budget["remaining"] -= len(chunk)
            if budget["remaining"] < 0:
                raise ArchiveError(
                    "Archive expands beyond the allowed size", "ARCHIVE_TOO_LARGE"
                )
            out.write(chunk)
            deadline.check()


def extract(payload: dict):
    root = os.path.realpath(payload["root"])
    archive = os.path.realpath(payload["archive"])
    dest = os.path.realpath(payload["dest"])
    overwrite = bool(payload.get("overwrite", False))
    limits = payload["limits"]
    deadline = Deadline(float(payload.get("timeoutSeconds", 480)))

    for label, value in (("archive", archive), ("destination", dest)):
        if not is_inside(value, root):
            raise ArchiveError(f"The {label} is outside the project", "PATH_TRAVERSAL")
    if not os.path.isfile(archive):
        raise ArchiveError("Archive not found", "SOURCE_NOT_FOUND")
    os.makedirs(dest, exist_ok=True)
    if not is_inside(dest, root):
        raise ArchiveError("The destination is outside the project", "PATH_TRAVERSAL")

    fmt = detect_format(archive)
    archive_size = os.path.getsize(archive)
    staging = os.path.join(root, f"{STAGING_PREFIX}{secrets.token_hex(8)}")

    handle = open_archive(archive, fmt)
    try:
        entries = list_zip_entries(handle) if fmt == "zip" else list_tar_entries(handle)
        to_write, skipped = validate_entries(entries, archive_size, limits)

        if not overwrite:
            conflicts = [
                rel
                for rel, entry in to_write
                if not entry.is_dir and os.path.lexists(os.path.join(dest, *rel.split("/")))
            ]
            if conflicts:
                shown = ", ".join(conflicts[:5])
                more = f" and {len(conflicts) - 5} more" if len(conflicts) > 5 else ""
                raise ArchiveError(
                    f"{len(conflicts)} file(s) already exist: {shown}{more}", "CONFLICT"
                )

        os.mkdir(staging, 0o700)
        budget = {"remaining": limits["maxBytes"]}
        written_files = 0

        for rel, entry in to_write:
            deadline.check()
            target = os.path.join(staging, *rel.split("/"))
            if not is_inside(target, staging):
                raise ArchiveError(f'Archive entry "{rel}" escapes the destination', "UNSAFE_ARCHIVE")
            if entry.is_dir:
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if fmt == "zip":
                with handle.open(entry.handle) as src:
                    copy_member(src, target, budget, deadline)
            else:
                src = handle.extractfile(entry.handle)
                if src is None:
                    continue
                with src:
                    copy_member(src, target, budget, deadline)
            os.chmod(target, safe_mode(entry.mode, False))
            written_files += 1

        # Staging is fully built and contains only regular files and folders.
        # Move into place, re-checking each destination parent so a symlink
        # that already exists inside the destination cannot redirect a write.
        for current, _dirs, files in os.walk(staging):
            deadline.check()
            rel_dir = os.path.relpath(current, staging)
            target_dir = dest if rel_dir == "." else os.path.join(dest, rel_dir)
            if os.path.islink(target_dir) or not is_inside(target_dir, root):
                raise ArchiveError(
                    "Destination contains a link that leaves the project", "UNSAFE_ARCHIVE"
                )
            if not os.path.isdir(target_dir):
                os.makedirs(target_dir)
                os.chmod(target_dir, 0o755)
            for name in files:
                final = os.path.join(target_dir, name)
                if os.path.isdir(final) and not os.path.islink(final):
                    raise ArchiveError(f'"{name}" already exists as a folder', "CONFLICT")
                os.replace(os.path.join(current, name), final)
    finally:
        handle.close()
        shutil.rmtree(staging, ignore_errors=True)

    ok({"extracted": written_files, "skipped": skipped, "format": fmt})


# ---------------------------------------------------------------------------
# compress
# ---------------------------------------------------------------------------

def compress(payload: dict):
    root = os.path.realpath(payload["root"])
    dest = os.path.abspath(payload["dest"])
    sources = payload["sources"]
    limits = payload["limits"]
    deadline = Deadline(float(payload.get("timeoutSeconds", 480)))

    if not is_inside(os.path.dirname(dest), root):
        raise ArchiveError("The destination is outside the project", "PATH_TRAVERSAL")
    if not dest.lower().endswith(".zip"):
        raise ArchiveError("The archive name must end in .zip", "UNSUPPORTED_FORMAT")
    if os.path.lexists(dest):
        raise ArchiveError("An archive with that name already exists", "CONFLICT")
    if not sources:
        raise ArchiveError("Nothing selected to compress", "VALIDATION_ERROR")

    resolved: list[tuple[str, str]] = []
    top_names: set[str] = set()
    for src in sources:
        absolute = os.path.abspath(src)
        if os.path.islink(absolute) or not is_inside(absolute, root):
            raise ArchiveError("A selected item is outside the project", "PATH_TRAVERSAL")
        if not os.path.exists(absolute):
            raise ArchiveError("A selected item no longer exists", "SOURCE_NOT_FOUND")
        base = os.path.basename(absolute)
        if base in top_names:
            raise ArchiveError(f'Two selected items are both named "{base}"', "CONFLICT")
        top_names.add(base)
        resolved.append((absolute, base))

    files_to_add: list[tuple[str, str]] = []
    dirs_to_add: list[str] = []
    skipped_links = 0
    total = 0

    for absolute, base in resolved:
        if os.path.isfile(absolute):
            files_to_add.append((absolute, base))
            total += os.path.getsize(absolute)
            continue
        dirs_to_add.append(base + "/")
        for current, dirnames, filenames in os.walk(absolute, followlinks=False):
            deadline.check()
            rel_dir = os.path.relpath(current, os.path.dirname(absolute)).replace(os.sep, "/")
            for d in list(dirnames):
                full = os.path.join(current, d)
                if os.path.islink(full):
                    skipped_links += 1
                    dirnames.remove(d)
                else:
                    dirs_to_add.append(f"{rel_dir}/{d}/")
            for f in filenames:
                full = os.path.join(current, f)
                if os.path.islink(full) or not os.path.isfile(full):
                    skipped_links += 1
                    continue
                if os.path.realpath(full) == os.path.realpath(dest):
                    continue
                files_to_add.append((full, f"{rel_dir}/{f}"))
                total += os.path.getsize(full)
            if len(files_to_add) > limits["maxEntries"]:
                raise ArchiveError("Too many files to compress", "ARCHIVE_TOO_LARGE")
            if total > limits["maxBytes"]:
                raise ArchiveError("Selection is too large to compress", "ARCHIVE_TOO_LARGE")

    if len(files_to_add) > limits["maxEntries"]:
        raise ArchiveError("Too many files to compress", "ARCHIVE_TOO_LARGE")
    if total > limits["maxBytes"]:
        raise ArchiveError("Selection is too large to compress", "ARCHIVE_TOO_LARGE")

    tmp = f"{dest}.{secrets.token_hex(6)}.tmp"
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in dirs_to_add:
                zf.writestr(name, b"")
            for full, arcname in files_to_add:
                deadline.check()
                zf.write(full, arcname)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    ok({"files": len(files_to_add), "skippedLinks": skipped_links})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        fail("Invalid JSON payload", "BAD_REQUEST")
        return

    command = payload.get("command")
    try:
        if command == "extract":
            extract(payload)
        elif command == "compress":
            compress(payload)
        else:
            fail(f"Unknown command: {command}", "BAD_REQUEST")
    except ArchiveError as exc:
        fail(exc.message, exc.code)
    except (zipfile.BadZipFile, tarfile.TarError, EOFError, zlib.error) as exc:
        fail(f"Archive is corrupt or unreadable: {exc}", "CORRUPT_ARCHIVE")
    except (KeyError, TypeError) as exc:
        fail(f"Invalid payload: {exc}", "BAD_REQUEST")
    except OSError as exc:
        fail(f"File system error: {exc.strerror or exc}", "FS_ERROR")


if __name__ == "__main__":
    main()
