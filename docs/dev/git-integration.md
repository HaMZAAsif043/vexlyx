# F1.3 — Git Repository Integration

## What This Feature Does

Allows users to connect a GitHub, GitLab, or Bitbucket repository to a Vexlyx project. It clones the repo into an isolated workspace directory, generates Ed25519 SSH keys for private repos, and provides a webhook URL (secret pre-generated) for future auto-deploy integration (F2.7).

This is the manual provider-neutral flow. GitHub users can instead connect the panel's GitHub App, browse authorized repositories, and use short-lived installation tokens without deploy keys. See [GitHub Integration](github-integration.md).

Create, update and connect all require an exact `github.com`, `gitlab.com` or `bitbucket.org` host, using HTTPS or `git@host:owner/repo` SSH syntax. Repository path segments may contain letters, digits, underscores, periods and hyphens (including nested GitLab groups). Plain HTTP, URL credentials, custom ports, URL escapes and other protocols/hosts are rejected. The Python clone boundary checks previously stored URLs too, before commands or workspace changes; invalid URLs return `INVALID_GIT_URL`. Git HTTP redirects are disabled, so use the canonical URL after a repository rename. Existing workspaces fetch only the validated `origin` remote. Changing or clearing a project's Git URL clears its GitHub App association; unchanged URLs preserve it.

---

## Architecture

```
Dashboard (GitSettings.tsx)
    │
    │  POST /api/projects/:id/git/connect
    │  POST /api/projects/:id/git/ssh-key
    │  GET  /api/projects/:id/git
    ▼
API (apps/api/src/modules/git/)
    ├── routes.ts   — Fastify route handlers (auth-gated)
    ├── service.ts  — Business logic, spawns Python
    └── schema.ts   — Re-exports ConnectRepoSchema from @vexlyx/shared
         │
         │  stdin: JSON payload
         │  stdout: JSON result
         ▼
    system/python/git_manager.py
         │
         ├── cmd_clone()          — git clone / git pull
         └── cmd_generate_ssh_key() — ssh-keygen Ed25519
```

### Data Flow

1. **User enters git URL + branch** in `GitSettings.tsx`
2. **Dashboard** calls `POST /api/projects/:id/git/connect` (JSON body)
3. **API `gitRoutes`** validates with `ConnectRepoSchema` → calls `GitService.connectRepo()`
4. **`GitService`** spawns `git_manager.py clone` with a JSON payload on stdin
5. **Python script** runs `git clone` and writes `{"success": true, "path": "..."}` to stdout
6. **Service** persists `gitUrl`, `branch`, `webhookSecret` to `Project` record in PostgreSQL
7. **Dashboard** shows success toast + renders SSH key and webhook URL sections

---

## Key Files

| File | Role |
|------|------|
| [`apps/api/src/modules/git/routes.ts`](../apps/api/src/modules/git/routes.ts) | 3 authenticated Fastify routes |
| [`apps/api/src/modules/git/service.ts`](../apps/api/src/modules/git/service.ts) | `GitService` class, `runGitManager()` helper |
| [`apps/api/src/modules/git/schema.ts`](../apps/api/src/modules/git/schema.ts) | Re-exports `ConnectRepoSchema` |
| [`system/python/git_manager.py`](../system/python/git_manager.py) | Python subprocess: clone, ssh-keygen |
| [`packages/shared/src/schemas/projects.ts`](../packages/shared/src/schemas/projects.ts) | `ConnectRepoSchema`, `GitMetadata` type |
| [`apps/dashboard/src/hooks/useGitSettings.ts`](../apps/dashboard/src/hooks/useGitSettings.ts) | React hook: fetch + mutate git state |
| [`apps/dashboard/src/components/projects/GitSettings.tsx`](../apps/dashboard/src/components/projects/GitSettings.tsx) | UI panel (repo form, SSH key, webhook URL) |

---

## Database Changes

Three new optional columns on the `Project` model:

| Column | Type | Purpose |
|--------|------|---------|
| `webhook_secret` | `String?` | 32-byte random hex HMAC secret (used by F2.7) |
| `ssh_public_key` | `String?` | Ed25519 public key shown to user |
| `ssh_private_key_path` | `String?` | Absolute disk path to private key |

Migration: `20260829183245_add_git_fields_to_project`

---

## Environment Variables

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `PROJECTS_DIR` | `./workspaces/projects` | Root for cloned repos |
| `SSH_KEYS_DIR` | `./workspaces/keys` | Root for SSH key pairs |
| `API_BASE_URL` | `http://localhost:5000` | Prefix for webhook URL |

---

## API Reference

### `GET /api/projects/:id/git`
Returns git metadata for a project.

**Response:**
```json
{
  "gitUrl": "https://github.com/user/repo",
  "branch": "main",
  "sshPublicKey": "ssh-ed25519 AAAA...",
  "webhookUrl": "http://localhost:5000/api/webhooks/github?projectId=xxx",
  "isPrivate": true
}
```

### `POST /api/projects/:id/git/connect`
Clones (or re-pulls) the repository.

**Body:**
```json
{ "gitUrl": "https://github.com/user/repo", "branch": "main", "isPrivate": false }
```

**Response:** Same shape as `GET`.

### `POST /api/projects/:id/git/ssh-key`
Generates a new Ed25519 key pair. **Overwrites** any existing key for this project.

**Response:**
```json
{ "publicKey": "ssh-ed25519 AAAA..." }
```

---

## How to Test

### 1. Public repo clone
```bash
# Start the API
pnpm dev

# Connect a public repo to an existing project
curl -X POST http://localhost:5000/api/projects/<PROJECT_ID>/git/connect \
  -H "Content-Type: application/json" \
  -d '{"gitUrl":"https://github.com/torvalds/linux","branch":"master"}' \
  --cookie "session=<YOUR_SESSION>"

# Verify the clone exists
ls ./workspaces/projects/<PROJECT_ID>
```

### 2. SSH key generation
```bash
curl -X POST http://localhost:5000/api/projects/<PROJECT_ID>/git/ssh-key \
  --cookie "session=<YOUR_SESSION>"
# Returns { "publicKey": "ssh-ed25519 AAAA..." }

# Add this key to your GitHub repo → Settings → Deploy Keys
# Then reconnect with the SSH URL:
curl -X POST http://localhost:5000/api/projects/<PROJECT_ID>/git/connect \
  -H "Content-Type: application/json" \
  -d '{"gitUrl":"git@github.com:user/private-repo.git","branch":"main"}' \
  --cookie "session=<YOUR_SESSION>"
```

### 3. Invalid URL rejection
```bash
curl -X POST http://localhost:5000/api/projects/<PROJECT_ID>/git/connect \
  -H "Content-Type: application/json" \
  -d '{"gitUrl":"https://notgithub.com/user/repo","branch":"main"}' \
  --cookie "session=<YOUR_SESSION>"
# → 422 with { "error": "Must be a GitHub, GitLab, or Bitbucket URL..." }
```

---

## How to Extend

### Add a new Git host (e.g. Codeberg)
Update both `GIT_URL_REGEX` in `packages/shared/src/schemas/projects.ts` and the clone boundary in `system/python/git_manager.py`. Keep exact host matching and HTTPS/SSH syntax restrictions, and add matching positive and negative tests in `apps/api/src/modules/projects/service.test.ts` and `tests/test_git_url_policy.py`.

### Add a `git pull` / refresh command
1. Add a new route `POST /api/projects/:id/git/pull` in `routes.ts`
2. Add `pullRepo()` to `GitService` — it calls `runGitManager({ command: "clone", ... })` (the Python `clone` command already handles pull when `.git` exists)

### Wire up webhook delivery (F2.7)
The `webhookSecret` is already generated and stored. In F2.7:
1. Add `POST /api/webhooks/github` route
2. Verify HMAC-SHA256 signature using `webhookSecret`
3. Queue a deployment job via BullMQ
