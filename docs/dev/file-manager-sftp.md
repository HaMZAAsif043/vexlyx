# File Manager & SFTP Access (F2.8)

> **Status:** 🟢 COMPLETED
> **Feature:** F2.8 — Web-based file manager with CodeMirror editor, WordPress export/import, and chrooted SFTP access.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Security Model](#security-model)
4. [API Reference](#api-reference)
5. [SFTP Module](#sftp-module)
6. [WordPress Export / Import](#wordpress-export--import)
7. [Dashboard Components](#dashboard-components)
8. [Environment Variables](#environment-variables)
9. [Python Scripts](#python-scripts)
10. [Database Schema](#database-schema)

---

## Overview

F2.8 adds the capabilities below (F5.24 later added permissions and archives):

| Capability | Delivery |
|---|---|
| Web File Manager | Two-pane browser-embedded IDE at `/projects/:id/files` |
| Permissions & Archives | Change file modes, extract `.zip`/`.tar.*` archives and compress selections (F5.24, see [File Manager: Permissions & Archives](file-manager-permissions-archives.md)) |
| WordPress Backup | One-click export (files + mysqldump) and import (extract + SQL restore) |
| SFTP Access | Chrooted Linux user, one per Vexlyx account, all projects accessible |

---

## Architecture

```
Dashboard (Next.js)
├── /projects/:id                  ← FileManagerCard (compact, 5 recent files)
│                                     SftpPanel (provision / credentials)
│                                     WordPressPanel (export / import buttons)
└── /projects/:id/files            ← Standalone full-screen FileManager (new tab)
    ├── (standalone)/layout.tsx    ← Full-viewport layout (no sidebar / header)
    ├── (standalone)/.../page.tsx  ← Two-pane editor + toolbar
    ├── FileTree (lazy-loaded tree, controlled context menu)
    └── FileEditor (CodeMirror 6)

API (Fastify)
├── /api/files/:id/*               ← FileService + routes
├── /api/sftp/*                    ← SftpService + routes (delegates to Python)
└── /api/projects/:id/wordpress/*  ← WordPressService (export/import added to F2.4)

System Layer
├── system/python/sftp_manager.py  ← Linux user management (useradd, chpasswd, etc.)
└── system/python/build_manager.py ← wordpress-export + wordpress-import commands
```

---

## Security Model

### Path Traversal Prevention

All file paths from clients go through `safePath()` in `apps/api/src/modules/files/schema.ts`:

1. **Null byte rejection** — raw `\0` in path → 400
2. **POSIX normalize** — `path.posix.normalize()` resolves `.` and `..`
3. **Leading `..` check** — if normalized starts with `..` → 403
4. **Absolute path reject** — `/` prefix → 403
5. **Root resolve + prefix guard** — `path.resolve(projectRoot, sanitized)` must have `projectRoot + path.sep` as prefix → 403
6. **Symlink escape guard** — `fs.realpath()` run on result; real path must still start with `projectRoot` → 403

### Blocked Write Targets

These filenames are blocked for all write/delete operations:

| Pattern | Reason |
|---|---|
| `.env`, `.env.*` | Protect API secrets |
| `wp-config.php` | Protect DB credentials |

### Project Ownership

Every request calls `findOwnedProject(userId, projectId)` which queries Prisma:
- Project must exist and not be soft-deleted
- `project.userId` must equal the authenticated session `userId`
- Returns 404 (not 403) on mismatch to avoid leaking project IDs

### SFTP Username Safety

All SFTP Linux usernames are validated against `/^vsftp_[a-z0-9]{8,32}$/` before any shell command runs. No user-supplied strings are passed to shell — all `subprocess.run()` calls use list form (no shell=True).

---

## API Reference

### File Operations

All endpoints require authentication (`requireAuth` preHandler).

#### `GET /api/files/:id/list`

List directory contents.

| Query | Type | Default | Description |
|---|---|---|---|
| `path` | string | `""` | Relative path from project root |
| `depth` | 1–3 | `1` | How many levels to return |

**Response:**
```json
{
  "nodes": [
    { "name": "src", "path": "src", "type": "dir" },
    { "name": "index.php", "path": "index.php", "type": "file", "size": 1024, "mtime": "...", "extension": "php" }
  ]
}
```

#### `GET /api/files/:id/read`

Read file content. Max 2 MB.

| Query | Type | Description |
|---|---|---|
| `path` | string | Relative file path |

**Response:** `{ "content": "..." }`

#### `POST /api/files/:id/create`

Create a new file. Guarantees zero overwriting: if a file, directory, or symlink already exists at the target path, returns `409 Conflict` with code `FILE_ALREADY_EXISTS`.

```json
{ "path": "src/new-file.ts", "content": "" }
```

#### `POST /api/files/:id/write`

Save file content atomically (write to `.tmp` then rename). Used by the in-browser `FileEditor` when saving modifications to an existing file. Blocks overwriting a directory.

```json
{ "path": "src/index.php", "content": "<?php echo 'hello'; ?>" }
```

#### `DELETE /api/files/:id/delete`

Delete file or directory recursively.

```json
{ "path": "old-plugin" }
```

#### `POST /api/files/:id/rename`

```json
{ "from": "old-name.php", "to": "new-name.php" }
```

#### `POST /api/files/:id/mkdir`

```json
{ "path": "uploads/images" }
```

#### `POST /api/files/:id/copy` / `POST /api/files/:id/move`

```json
{ "from": "src/file.php", "to": "backup/file.php" }
```

#### `POST /api/files/:id/chmod`

Change permissions (F5.24). `mode` is three octal digits; `recursive` is opt-in and applies `mode` to folders and `fileMode` to files.

```json
{ "path": "storage", "mode": "755", "recursive": true, "fileMode": "644" }
```

#### `POST /api/files/:id/extract`

Extract a `.zip`, `.tar`, `.tar.gz` or `.tar.bz2` archive (F5.24). `destination` defaults to the archive's folder (`"."` is the project root); existing files are only replaced with `overwrite: true`.

```json
{ "path": "uploads/site.zip", "destination": "public", "overwrite": false }
```

#### `POST /api/files/:id/compress`

Zip a selection of files and folders (F5.24).

```json
{ "paths": ["src", "README.md"], "destination": "backup.zip" }
```

Safety rules, limits and error codes for these three endpoints are in [File Manager: Permissions & Archives](file-manager-permissions-archives.md).

#### `GET /api/files/:id/download`

Streams file as `application/octet-stream` download.

| Query | Type | Description |
|---|---|---|
| `path` | string | Relative file path |

#### `POST /api/files/:id/upload`

Multipart form upload. Max 100 MB per file (configurable via `FILE_UPLOAD_MAX_MB`).

| Field | Type | Description |
|---|---|---|
| `path` | string (field) | Target directory |
| `file` | binary (file) | The file to upload |

---

## SFTP Module

### How It Works

1. User clicks **Provision SFTP Access** in the `SftpPanel`
2. API calls `SftpService.provision(userId)`:
   - Derives `linux_username = vsftp_<sanitized_userId>`
   - Generates a 20-char random password
   - Calls `sftp_manager.py` via stdin JSON → stdout JSON
   - Python script: `useradd`, `chpasswd`, writes `/etc/ssh/sshd_config.d/vexlyx-sftp.conf`
   - Stores encrypted password in `sftp_users` Postgres table
3. Credentials returned to frontend: host, port, username, password (shown once in full)

### OpenSSH Configuration

`sftp_manager.py` writes a Match block for each user:

```
Match User vsftp_abc123
    ChrootDirectory /opt/vexlyx/projects/<userId>
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
```

The chroot directory **must be owned by root** (OpenSSH requirement). All project subdirectories are owned by the application user. SFTP users cannot escape to other users' directories.

### Project Mapping into Chroot Jail

Because Vexlyx stores individual project workspaces at `/opt/vexlyx/projects/<projectId>`, `sftp_manager.py` exposes each user's projects inside `/opt/vexlyx/projects/<userId>/<projectName>`:
- **On Linux (POSIX)**: OpenSSH chroot requires directories inside the jail to be actual mountpoints or physical paths. `sftp_manager.py` bind-mounts `/opt/vexlyx/projects/<projectId>` into `/opt/vexlyx/projects/<userId>/<projectName>` (`mount --bind`) and ensures ownership belongs to `vsftp_<suffix>`.
- **On Windows / Dev**: Directory junctions / symlinks map `<projectName>` inside the chroot jail to `<projectId>`.
- **Synchronization**: Project mappings are refreshed automatically whenever the user provisions SFTP, fetches credentials, or re-enables SFTP.

### Password Encryption

Passwords are authenticated and encrypted at rest with AES-256-GCM using the centralized `apps/api/src/utils/encryption.ts` utility:

```
<iv_hex>:<tag_hex>:<ciphertext_hex>
```

Key derivation uses SHA-256 over `ENCRYPTION_KEY` (falling back to `SESSION_SECRET`).

### SFTP API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sftp/provision` | Create SFTP account & map user projects |
| `GET` | `/api/sftp/credentials` | Return credentials & sync latest projects |
| `POST` | `/api/sftp/rotate-password` | Generate new password |
| `POST` | `/api/sftp/add-ssh-key` | Add SSH public key |
| `DELETE` | `/api/sftp/disable` | Lock account (`usermod --lock`) |
| `POST` | `/api/sftp/enable` | Unlock account (`usermod --unlock`) & sync projects |

---

## WordPress Export / Import

### Export Flow

```
GET /api/projects/:id/wordpress/export
  → WordPressService.exportSite()
    → build_manager.py wordpress-export command
      → reads DB credentials from wp-config.php
      → runs mysqldump → database.sql
      → tar.gz (files/ + database.sql)
  → streams tar.gz to browser as download
  → cleanup job deletes temp dir
```

### Import Flow

```
POST /api/projects/:id/wordpress/import (multipart)
  → streams tar.gz to /tmp/vexlyx-imports/:projectId/
  → WordPressService.importSite()
    → build_manager.py wordpress-import command
      → validates tar (no traversal members)
      → extracts to temp dir
      → copies files/ → project dir
      → imports *.sql via mysql CLI
      → writes fresh wp-config.php
  → updates DB credential env vars
  → cleans up temp files
```

> **Note:** The client must provide DB credentials (name, user, password, host) in the multipart form fields. These are used to write the new `wp-config.php` and run the SQL import.

---

## Dashboard Components

### `FileManagerCard`

Location: `apps/dashboard/src/components/projects/FileManagerCard.tsx`

Compact widget shown on the project detail page. Shows 5 most recently modified files and an **Open** button linking to the full-screen file manager in a new tab (`target="_blank"`).

### Project Header Quick Access

Location: `apps/dashboard/src/app/(panel)/projects/[id]/page.tsx`

The top action bar includes a prominent **File Manager** button with `target="_blank" rel="noopener noreferrer"`, enabling quick one-click access directly from the project overview without needing to scroll down.

### Full-Screen Standalone File Manager

Location: `apps/dashboard/src/app/(standalone)/projects/[id]/files/page.tsx`
Layout: `apps/dashboard/src/app/(standalone)/layout.tsx`

Opens in a dedicated browser tab using the `(standalone)` route group layout:
- **100% viewport real estate** (`h-screen w-screen overflow-hidden`) with no panel sidebar and no dashboard header
- **Authentication**: Validates session cookie against `/api/auth/me`, redirecting to `/login` if unauthenticated
- **Deep Linking**: Inspects `?open=<filepath>` search params to automatically open a specific file on load

Two-pane layout:
- **Left (288px):** `FileTree` — lazy-loaded directory tree with controlled context menu
- **Right (flex):** `FileEditor` (CodeMirror 6) or clean empty state with quick action buttons

Top toolbar:
- Project name and runtime badge (`WORDPRESS`, `NODEJS`, etc.)
- Clickable breadcrumb path navigation (`/ wp-content / themes / ...`)
- New File / New Folder / Upload / Download (when file selected) / Refresh buttons
- Built-in Dark/Light theme toggle
- Exit link returning to the project detail view

### `FileTree`

Location: `apps/dashboard/src/components/files/FileTree.tsx`

Lazy-loads children on folder expand via `GET /api/files/:id/list`. Supports:
- File-type icons (code, image, config, generic)
- 3-dots action menu with controlled `isMenuOpen` state (does not unmount when cursor moves to the Radix Portal dropdown)
- Actions: Rename, Copy path, Delete
- Keyboard navigation (Enter/Space) and event isolation (`e.stopPropagation()`)

### `FileEditor`

Location: `apps/dashboard/src/components/files/FileEditor.tsx`

CodeMirror 6 with:
- Language auto-detection from file extension (JS/TS/JSX/TSX, CSS, HTML, JSON, YAML, Markdown, PHP)
- `oneDark` theme
- Ctrl+S / Cmd+S keyboard shortcut to save
- Unsaved indicator (amber dot in tab)
- Atomic save via API (temp file write + rename)

---

## Live File Changes vs. Redeployment Semantics

When editing files in the File Manager, whether you need to redeploy depends on the runtime and file location:

| Project Type | Target File | Needs Redeploy? | Behavior |
| :--- | :--- | :--- | :--- |
| **WordPress** | `wp-content/**`<br>(Themes, `functions.php`, `style.css`, Plugins, Uploads) | ❌ **No redeploy needed** | Live volume mounted (`../wp-content:/app/wp-content`). Changes take effect **instantly** on page refresh. |
| **WordPress** | Core files (`wp-config.php`, `.htaccess`, `.php` root files) | 🔄 **Yes, Rebuild / Redeploy** | Baked into the Nixpacks Docker image during build. |
| **Node.js / Next.js / React** | Any source files (`.ts`, `.tsx`, `.js`, components, styles) | 🔄 **Yes, Redeploy** | Compiled applications must be rebuilt by Nixpacks into a new container image. |
| **Python** | `.py` source code, templates | 🔄 **Yes, Redeploy** | Source code is baked into the Nixpacks image on deploy. |
| **All Runtimes** | Environment variables changed | ⚡ **Restart container only** | Quick container restart (~2s) re-reads env vars without image rebuild. |

### `SftpPanel`

Location: `apps/dashboard/src/components/projects/SftpPanel.tsx`

Handles full SFTP lifecycle:
- **Not provisioned:** Shows provision button
- **Provisioned:** Shows connection command (`sftp -P <port> <user>@<host>`), 3-column grid (**Host**, **Port**, **Username** with one-click copy buttons), masked password (reveal toggle + copy), SSH public key textarea + Add button
- **Actions:** Rotate Password (with confirmation dialog), Disable SFTP (with confirmation dialog), Enable SFTP (when disabled)

---

## Environment Variables

Add to `apps/api/.env`:

```env
# File Manager & SFTP (F2.8)
FILE_UPLOAD_MAX_MB=100
SFTP_HOST=your-server-ip-or-hostname  # optional; defaults to request hostname or localhost
SFTP_PORT=22

# Archive extract / compress limits (F5.24)
FILE_ARCHIVE_MAX_BYTES=2147483648
FILE_ARCHIVE_MAX_ENTRIES=50000
FILE_ARCHIVE_MAX_RATIO=100
```

`ENCRYPTION_KEY` (32+ chars) is used for SFTP password encryption. It is required in production and must differ from `SESSION_SECRET`; outside production it falls back to `SESSION_SECRET` (#69, see [Environment Variables](environment-variables.md)).

---

## Python Scripts

### `system/python/sftp_manager.py`

| Command | Purpose |
|---|---|
| `sftp-provision` | `useradd` + `chpasswd` + write sshd_config Match block + sync projects |
| `sftp-rotate-password` | `chpasswd` with new password |
| `sftp-add-ssh-key` | Append to `~/.ssh/authorized_keys` |
| `sftp-disable` | `usermod --lock` |
| `sftp-enable` | `usermod --unlock` + sync projects |
| `sftp-sync-projects` | Mount/link user project directories inside chroot jail |

**Interface:** JSON on stdin → JSON on stdout. Exit 0 = success, exit 1 = error.

**Requires:** `sudo` privileges for `useradd`, `usermod`, `chpasswd`.

### `system/python/build_manager.py` additions

| Command | Purpose |
|---|---|
| `wordpress-export` | `mysqldump` + `tar.gz` creation |
| `wordpress-import` | Extract tar, `mysql` import, write `wp-config.php` |

---

## Database Schema

```prisma
model SftpUser {
  id                String   @id @default(cuid())
  userId            String   @unique
  linuxUsername     String   @unique  // vsftp_<suffix>
  encryptedPassword String?           // AES-256-GCM iv:tag:ciphertext
  sshPublicKeys     String[] @default([])
  isEnabled         Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("sftp_users")
}
```

Migration: `20260906014238_add_sftp_users`

---

## Production Checklist

- [ ] Run `sudo visudo` to grant API user `useradd`, `usermod`, `chpasswd`, `systemctl reload sshd` without password
- [ ] Ensure `/etc/ssh/sshd_config.d/` directory exists and `Include /etc/ssh/sshd_config.d/*.conf` is in main sshd_config
- [ ] Set `FILE_UPLOAD_MAX_MB`, `SFTP_HOST`, `SFTP_PORT` in production `.env`
- [ ] Set `ENCRYPTION_KEY` (32+ random chars) for SFTP password encryption
- [ ] Ensure `mysqldump` and `mysql` CLIs are installed for WordPress export/import
- [ ] Create `/tmp/vexlyx-exports` and `/tmp/vexlyx-imports` with correct permissions
