import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid


GENERATION = re.compile(r"^[0-9a-f]{32}$")
PROBE = "__vexlyx_generation__"


class MailStateError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.details = {"retry": "Use Mail > Synchronize after correcting the mail service error.", **details}


def state_root():
    configured = os.environ.get("VEXLYX_MAIL_STATE_DIR")
    if configured:
        return Path(configured).resolve()
    return Path(__file__).resolve().parents[2] / "docker" / "mail-data" / "state"


def atomic_write(path, content, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".mail-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content if isinstance(content, bytes) else content.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def state_lock(timeout=60):
    root = state_root()
    root.mkdir(parents=True, exist_ok=True, mode=0o750)
    with (root / ".sync.lock").open("a+b") as lock:
        lock.seek(0)
        lock.write(b"0")
        lock.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (BlockingIOError, OSError):
                if time.monotonic() >= deadline:
                    raise MailStateError("MAIL_SYNC_BUSY", "Another mail synchronization is still running.")
                time.sleep(0.05)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def active_generation(component):
    path = state_root() / component / "active.conf"
    if not path.exists():
        return None
    lines = path.read_text(encoding="utf-8").splitlines()
    first = lines[0] if lines else ""
    generation = first.removeprefix("# generation:")
    if not GENERATION.fullmatch(generation):
        raise MailStateError("MAIL_STATE_INVALID", f"Invalid active generation for {component}.", component=component)
    return generation


def active_directory(component):
    generation = active_generation(component)
    if generation is None:
        raise MailStateError("MAIL_STATE_NOT_INITIALIZED", "Mail state is not initialized. Run the mail-state migration or installer.", component=component)
    return state_root() / component / "generations" / generation


def activation(component, generation):
    if component not in ("postfix", "dovecot") or not GENERATION.fullmatch(generation):
        raise ValueError("Invalid mail generation")
    base = f"/var/lib/vexlyx-mail/{component}/generations/{generation}"
    header = f"# generation:{generation}\n"
    if component == "postfix":
        return header + f"virtual_mailbox_domains = {base}/virtual_domains\nvirtual_mailbox_maps = lmdb:{base}/virtual_mailbox_maps\nvirtual_alias_maps = lmdb:{base}/virtual_alias_maps\n"
    return header + f"passdb {{\n  driver = passwd-file\n  args = scheme=ARGON2ID username_format=%u {base}/users\n}}\nuserdb {{\n  driver = passwd-file\n  args = username_format=%u {base}/users\n}}\n"


def run_service(component, action, generation=None):
    container = os.environ.get(f"VEXLYX_{component.upper()}_CONTAINER", f"vexlyx-{component}")
    arguments = ["docker", "exec", container, "/usr/local/bin/mail-state.sh", action]
    if generation:
        arguments.append(generation)
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MailStateError("MAIL_STATE_SERVICE_UNAVAILABLE", f"Cannot {action} {component} mail state.", component=component, phase=action) from exc
    if result.returncode:
        # Service diagnostics never contain the stdin payload or password hashes.
        raise MailStateError("MAIL_STATE_ACTIVATION_FAILED", f"{component} mail state {action} failed.",
                             component=component, phase=action, diagnostic=result.stderr.strip()[-2000:])
    if action == "health":
        try:
            visible = subprocess.run(["docker", "exec", container, "sha256sum",
                                  f"/var/lib/vexlyx-mail/{component}/active.conf"],
                                 capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise MailStateError("MAIL_STATE_SERVICE_UNAVAILABLE", f"Cannot verify {component} mail state.", component=component, phase="verify") from exc
        expected = hashlib.sha256((state_root() / component / "active.conf").read_bytes()).hexdigest()
        if visible.returncode or not visible.stdout.startswith(expected + " "):
            raise MailStateError("MAIL_STATE_MOUNT_STALE", f"{component} is reading a different mail-state activation file.",
                                 component=component, phase="verify", retry="Recreate the affected mail container with the current Compose mounts, then synchronize mail.")


def read_lines(component, filename):
    path = active_directory(component) / filename
    return [line for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith(PROBE)]


def stage(component, files):
    generation = uuid.uuid4().hex
    path = state_root() / component / "generations" / generation
    path.mkdir(parents=True, mode=0o750 if component == "dovecot" else 0o755)
    try:
        for name, content in files.items():
            atomic_write(path / name, content, 0o640 if component == "dovecot" else 0o644)
    except Exception as exc:
        cleanup_errors = discard_generations({component: generation})
        raise MailStateError("MAIL_STATE_WRITE_FAILED", "Could not stage mail state.", cleanupFailed=cleanup_errors) from exc
    return generation


def discard_generations(updates):
    failed = []
    for component, generation in updates.items():
        try:
            if component not in ("postfix", "dovecot") or not GENERATION.fullmatch(generation):
                raise ValueError("Invalid mail generation")
            if active_generation(component) == generation:
                continue
            parent = state_root() / component / "generations"
            directory = parent / generation
            if directory.is_symlink():
                raise ValueError("Refusing symlinked mail generation")
            directory.resolve().relative_to(parent.resolve())
            if directory.exists():
                shutil.rmtree(directory)
        except (OSError, ValueError, MailStateError):
            failed.append(component)
    return failed


def cleanup(component, keep):
    parent = state_root() / component / "generations"
    for directory in parent.iterdir():
        if directory.name in keep or not GENERATION.fullmatch(directory.name) or directory.is_symlink():
            continue
        # Only remove agent-generated generations inside the resolved runtime directory.
        directory.resolve().relative_to(parent.resolve())
        shutil.rmtree(directory)


def publish(updates):
    published = False
    try:
        previous = {component: (state_root() / component / "active.conf").read_bytes() for component in updates}
        old_generations = {component: active_generation(component) for component in updates}
        for component, generation in updates.items():
            run_service(component, "prepare", generation)
        published = True
        for component, generation in updates.items():
            atomic_write(state_root() / component / "active.conf", activation(component, generation), 0o644)
        # Activate auth first: SMTP must not accept a newly added recipient before userdb is ready.
        for component in ("dovecot", "postfix"):
            if component in updates:
                run_service(component, "activate")
                run_service(component, "health")
    except Exception as exc:
        rollback_errors = []
        if not published:
            cleanup_errors = discard_generations(updates)
            if isinstance(exc, MailStateError):
                exc.details["rollbackFailed"] = []
                if cleanup_errors:
                    exc.details["cleanupFailed"] = cleanup_errors
                raise
            raise MailStateError("MAIL_STATE_WRITE_FAILED", "Could not prepare mail state.", cleanupFailed=cleanup_errors) from exc
        for component, content in previous.items():
            try:
                atomic_write(state_root() / component / "active.conf", content, 0o644)
            except OSError:
                rollback_errors.append(component)
        for component in ("dovecot", "postfix"):
            if component in updates:
                try:
                    run_service(component, "activate")
                    run_service(component, "health")
                except MailStateError:
                    if component not in rollback_errors:
                        rollback_errors.append(component)
        # A daemon can still be using the failed generation until rollback health succeeds.
        cleanup_errors = discard_generations(updates) if not rollback_errors else []
        if isinstance(exc, MailStateError):
            exc.details["rollbackFailed"] = rollback_errors
            if cleanup_errors:
                exc.details["cleanupFailed"] = cleanup_errors
            raise
        raise MailStateError("MAIL_STATE_WRITE_FAILED", "Could not activate mail state.", rollbackFailed=rollback_errors, cleanupFailed=cleanup_errors) from exc
    for component, generation in updates.items():
        cleanup(component, {generation, old_generations[component]})
    return {"success": True, "generations": updates}


def validate_token(value, label):
    value = str(value).strip().lower()
    if not value or any(part in (".", "..") for part in value.split("@")) or any(character.isspace() or character in "\x00:\\/#,;=" for character in value):
        raise MailStateError("INVALID_MAIL_STATE", f"Invalid {label}.")
    return value


def postfix_files(domains, addresses, aliases):
    domains = sorted({validate_token(domain, "domain") for domain in domains})
    lines = []
    for address in sorted(set(addresses)):
        address = validate_token(address, "mailbox address")
        if address.count("@") != 1:
            raise MailStateError("INVALID_MAIL_STATE", "Invalid mailbox address.")
        local, domain = address.split("@")
        if not local or domain not in domains:
            raise MailStateError("INVALID_MAIL_STATE", "Mailbox does not belong to a synchronized domain.")
        lines.append(f"{address} {domain}/{local}/Maildir/")
    alias_lines = []
    for alias in sorted(aliases, key=lambda item: item["source"]):
        source = validate_token(alias["source"], "alias source")
        destinations = [validate_token(item, "alias destination") for item in alias["destinations"]]
        if source.count("@") != 1 or source.split("@")[1] not in domains or not destinations or any(item.count("@") != 1 for item in destinations):
            raise MailStateError("INVALID_MAIL_STATE", "Invalid alias.")
        alias_lines.append(source + "\t" + ",".join(destinations))
    return {"virtual_domains": "\n".join(domains) + "\n",
            "virtual_mailbox_maps": "\n".join(lines) + "\n",
            "virtual_alias_maps": "\n".join(alias_lines) + "\n"}


def passwd_lines(mailboxes):
    lines = []
    for mailbox in sorted(mailboxes, key=lambda item: item["address"]):
        address = validate_token(mailbox["address"], "mailbox address")
        password = str(mailbox["passwordHash"])
        if not password or any(character in password for character in "\r\n:\x00"):
            raise MailStateError("INVALID_MAIL_STATE", "Invalid mailbox password hash.")
        password = re.sub(r"(m=\d+),(p=\d+),(t=\d+)", r"\1,\3,\2", password)
        if not password.startswith("{"):
            password = "{ARGON2ID}" + password
        quota = int(mailbox.get("quotaMb", 1024))
        if quota < 0:
            raise MailStateError("INVALID_MAIL_STATE", "Invalid mailbox quota.")
        lines.append(f"{address}:{password}:5000:5000::::userdb_quota_rule=*:storage={quota}M")
    return "\n".join(lines) + ("\n" if lines else "")


def reconcile(payload):
    mailboxes = payload.get("mailboxes", [])
    files = postfix_files(payload.get("domains", []), [item["address"] for item in mailboxes], payload.get("aliases", []))
    component_files = {"postfix": files, "dovecot": {"users": passwd_lines(mailboxes)}}
    updates = {}
    try:
        for component, content in component_files.items():
            updates[component] = stage(component, content)
    except Exception as exc:
        cleanup_errors = discard_generations(updates)
        if isinstance(exc, MailStateError):
            exc.details["cleanupFailed"] = list(dict.fromkeys(exc.details.get("cleanupFailed", []) + cleanup_errors))
            raise
        raise MailStateError("MAIL_STATE_WRITE_FAILED", "Could not stage mail state.", cleanupFailed=cleanup_errors) from exc
    return publish(updates)
