# File Manager: Permissions & Archives (F5.24)

> **Status:** 🟢 COMPLETED
> **Feature:** Change file/folder permissions (chmod), extract `.zip` / `.tar` / `.tar.gz` / `.tar.bz2` archives and compress a selection into a `.zip`, all from the File Manager with no shell access.

## What It Does

| Action | Where | Notes |
|---|---|---|
| **Permissions** | tree item menu → *Permissions* | Owner/Group/Other × Read/Write/Execute checkboxes plus a raw octal field. Non-recursive by default. |
| **Extract** | tree item menu on an archive → *Extract* | Into the archive's folder by default, or a chosen folder (created if missing). |
| **Compress** | tree item menu → *Compress*, or Ctrl/Cmd+click several items then **Compress (N)** | Produces a `.zip` next to the first selected item. |

## Architecture

```
FileTree / PermissionsDialog / ArchiveDialogs   (dashboard)
        │  POST /api/files/:id/{chmod,extract,compress}
        ▼
files/routes.ts ──► FileService (service.ts)
                        │  resolveAndGuard(): ownership, safePath, realpath
                        ├─ chmod      → fs.chmod (Node built-in)
                        └─ extract / compress → system/python/archive_manager.py
                                                  (Python stdlib: zipfile / tarfile)
```

- **No new dependency.** chmod uses `fs.promises.chmod`; archives use the Python standard library, called the same way as the other `system/python/*` managers (JSON over stdin/stdout, interpreter from `getPythonBin()`, time-limited by `watchChildTimeout`).
- Every request is validated with Zod (`files/schema.ts`) and re-validated by the Python script, because an archive is untrusted input.

## API

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/api/files/:id/chmod` | `{ path, mode, recursive?, fileMode? }` | `200 { success, changed }` |
| POST | `/api/files/:id/extract` | `{ path, destination?, overwrite? }` | `200 { success, extracted, skipped[] }` |
| POST | `/api/files/:id/compress` | `{ paths[], destination }` | `201 { success, files, skippedLinks }` |

Directory listings (`GET /api/files/:id/list`) now include an octal `mode` per entry.

Errors use the standard `{ error, code, details }` shape. Notable codes: `UNSAFE_ARCHIVE` (422), `CORRUPT_ARCHIVE` (422), `ARCHIVE_TOO_LARGE` (413), `UNSUPPORTED_FORMAT` (415), `CONFLICT` (409), `INVALID_MODE` (400), `CHMOD_ROOT` (400), `FORBIDDEN` (403).

## Security Model

### chmod
- `mode` is exactly three octal digits, so setuid / setgid / sticky can never be set.
- The project root cannot be changed, and symbolic links are refused (chmod follows links).
- Folders must keep owner `rwx` (≥ `700`) and files owner `r`, so a change cannot lock the panel or the app out of its own data.
- Recursive mode is opt-in per request. `mode` applies to folders and `fileMode` (default: same) to files, so `755`/`644` is expressible. Symlinks inside the tree are skipped, never followed. One request is capped at 100 000 entries.

### Extract
The archive is scanned completely **before** anything is written:

1. Entry names are normalised; absolute paths (`/x`, `C:\x`), `..` segments and null bytes reject the **whole** archive (zip-slip).
2. Symbolic links, hard links, devices and encrypted entries reject the whole archive.
3. Entry count, total uncompressed size and compression ratio are checked against the limits below. Real bytes are counted again while streaming, since headers can lie.
4. Files are written to a hidden staging directory inside the project, then moved into the destination. Each destination parent is re-checked, so a pre-existing symlink cannot redirect a write.
5. Permission bits from the archive are ignored: files become `644` (or `755` if the owner execute bit was set), folders `755`.
6. Existing files are **not** overwritten unless `overwrite: true`; the extraction stops with `CONFLICT` and writes nothing.
7. `.env*` and `wp-config.php` entries are skipped and reported, mirroring the existing File Manager rule that these names are never written through it.

### Compress
Symlinks are never followed (they are left out and counted in `skippedLinks`), the destination may not already exist, and the archive is written to a temporary file and renamed into place.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FILE_ARCHIVE_MAX_BYTES` | `2147483648` (2 GiB) | Max total uncompressed size for extract / compress |
| `FILE_ARCHIVE_MAX_ENTRIES` | `50000` | Max entries per archive |
| `FILE_ARCHIVE_MAX_RATIO` | `100` | Max uncompressed ÷ compressed size (zip-bomb guard) |

The operation is backstopped by `PYTHON_SCRIPT_TIMEOUT_MS.archive` (540 s); the script's own deadline is 480 s.

## Audit Log

`file.permissions_changed`, `file.archive_extracted` and `file.archive_created` are written through `AuditLogService` with the project as target and a whitelist of fields (paths, modes, counts) in `after`.

## How To Test

Automated: `pnpm --filter @vexlyx/api test src/modules/files` — runs the real `archive_manager.py` against a temporary project directory (zip-slip, absolute paths, symlink entries, size limit, conflict, protected names, corrupt/unsupported files, compress selection, chmod incl. recursion and symlink safety, ownership 403, route auth 401 and validation). The POSIX permission-bit tests are skipped on Windows.

Manual:
1. Upload a `.zip` → *Extract* → files appear with correct contents.
2. Extract a zip-slip archive (`../../evil.txt` entry) → rejected, nothing written.
3. Ctrl/Cmd+click several items → **Compress** → the `.zip` downloads with exactly that content.
4. Set a file to `644` and a folder to `755` → confirm with `ls -la` on the host.
5. Toggle *Apply to contents* → only then are children changed.

## How To Extend

- **New format:** add it to `detect_format()` and the `open_archive()` mode map in `archive_manager.py`; the validation pipeline is format-agnostic (`Entry`).
- **New limit:** add an env var in `config/env.ts`, pass it in `archiveLimits()` (service) and enforce it in `validate_entries()`.
