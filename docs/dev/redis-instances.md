# Redis Instances (F5.30)

Users can provision PostgreSQL and MySQL databases (F2.6) but had no key-value store: an app that needs a cache, a session store or a job queue (BullMQ, Sidekiq, Celery, Laravel queues) had to bundle its own Redis in its project or go without. This feature provisions a **dedicated, password-protected Redis container per instance** on the internal Docker network, with a memory cap, an eviction policy, a persistence mode and a ready-to-paste connection URL.

## Why a container per instance (not a shared server)

Redis has no real multi-tenancy. Logical databases (0-15) share one memory pool, one CPU thread and one set of dangerous commands (`FLUSHALL`, `CONFIG`, `KEYS`, `DEBUG`), and one tenant can evict or wipe another's keys. PostgreSQL and MySQL are shared because a per-database user is a real isolation boundary there; for Redis **the boundary is the container**. The panel's own Redis (sessions/queues, `vexlyx-redis`) is never modeled or touched by this feature.

## Data model

One migration (`20261022000000_add_redis_instances`):

- **`RedisInstance`** — `name` (unique per user), `containerName` (compose-independent: `vexlyx-redis-<slug>-<rand>`), `imageTag` (pinned), `memoryLimitMb`, `evictionPolicy`, `persistence` (`NONE` | `RDB` | `AOF`), `passwordEncrypted` (AES-256-GCM via `utils/encryption.ts`), `status` (`CREATING` | `RUNNING` | `STOPPED` | `ERROR`), `userId` (cascade), `projectId` (set-null).
- **`User.maxRedisInstances`** — nullable quota wired through the same F5.20 machinery as every other resource (`assertUnderQuota`, reseller pool/oversell participation) with F5.23 threshold emails (`notifyQuotaThreshold`).

Passwords are **never** returned by list endpoints and never written to logs or the audit log; the detail endpoint reveals the full connection URL on demand.

## Image and licence

The image line is pinned in `RedisImageEnum` (`packages/shared/src/schemas/redisInstances.ts`) and enforced again server-side in `redis_manager.py` (allowlist — `latest` and arbitrary refs are rejected):

| Choice | Image | Rationale |
| --- | --- | --- |
| Default | `valkey/valkey:8.0` | Valkey is the BSD-licensed, actively maintained Redis fork |
| Alt | `redis:7.2-alpine` | Last Redis line before the RSALv2/SSPL/AGPL licence change |

## System layer — `system/python/redis_manager.py`

Same contract as `database_manager.py`: JSON on stdin, JSON on stdout, hard timeouts, docker invocations as argument lists only.

- **Config file, not flags.** Each instance gets a generated `redis.conf` on the host (`workspaces/redis-instances/<container>/redis.conf`, override with `REDIS_INSTANCE_CONFIG_DIR`), chmod 600, mounted **read-only** at `/usr/local/etc/redis/redis.conf`. It carries `requirepass`, `maxmemory`, `maxmemory-policy`, the persistence mode, and `rename-command` lines removing `CONFIG`, `FLUSHALL`, `FLUSHDB`, `DEBUG` and `SHUTDOWN`. The password therefore never appears in a command-line argument, environment variable or `docker inspect` field.
- **Health checks read the password from the config file** (`sh -c 'PW=$(sed -n "s/^requirepass //p" …)'`) — the `docker exec` snippet (`_CLI_SNIPPET`) never interpolates the password itself, so it stays out of host `ps` output too.
- **Container**: `traefik-net` only (no published host port), `--restart unless-stopped`, named volume `<container>-data:/data`, Docker memory limit = `memoryLimitMb + 32 MB` headroom (a background fork/AOF rewrite briefly doubles memory; OOM-killing the container for doing what it was told would look like a crash). Docker's `--memory-swap` is pinned equal so no swap escape hatch exists.
- **Commands**: `create_instance` (refuses to overwrite an existing container, waits for `healthy`, cleans up config on failure), `recreate_instance` (used for limit changes and password rotation — container replaced, **same volume**, hostname preserved), `delete_instance` (container + volume + config dir; reports `TEARDOWN_FAILED` instead of pretending success if the container survives), `start/stop/restart_instance`, `stats_instance` (parses `INFO` into JSON: used memory, % of maxmemory, key count, clients, evicted keys, uptime).
- Validation: identifiers, `[A-Za-z0-9]{16,128}` passwords (they are written verbatim into a config file, so the charset must never be able to alter its structure), image allowlist, eviction policy, persistence mode, memory bounds.

## API — `/api/redis`

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/redis` | Own instances (summaries, no password); `scope=all` requires ADMIN |
| `POST` | `/api/redis` | Create → 201; quota, name-conflict and memory-cap checks first |
| `GET` | `/api/redis/:id` | Detail incl. `connectionUrl` (password revealed on demand) |
| `PATCH` | `/api/redis/:id` | Change `memoryLimitMb` / `evictionPolicy` / `persistence` (recreates) |
| `POST` | `/api/redis/:id/start` `/stop` `/restart` | Power state |
| `POST` | `/api/redis/:id/rotate-password` | New password, container recreated; audit carries no secret |
| `GET` | `/api/redis/:id/stats` | Live `INFO` numbers; 409 `REDIS_NOT_RUNNING` when stopped |
| `DELETE` | `/api/redis/:id` | Teardown first, row deleted only after the engine confirms → 204 |

Ownership: other users' instances 404 (existence hidden); ADMIN may read/operate on any. Audit actions: `redis_instance.created` / `.updated` / `.password_rotated` / `.deleted` — whitelisted settings only, never credentials.

Failure ordering is deliberate:

- **Create**: container first, then the row; if the insert fails the container is torn down (no orphan behind a missing record).
- **Delete**: teardown first, row only after confirmation; a failed teardown keeps the row and returns 502 `REDIS_TEARDOWN_FAILED` (no deleted-but-running container).

If `projectId` is set and `autoInjectEnv` is true, the service writes `REDIS_URL`, `REDIS_HOST` and `REDIS_PORT` into the project's env vars via `EnvService.bulkUpsert` (F1.7).

## Dashboard

`/redis` page (`apps/dashboard/src/app/(panel)/redis/page.tsx`), sidebar item after Databases:

- Cards show status badge (Running/Stopped/Creating/Error), image, memory limit, eviction policy, project link; actions: details & URI, start/stop, configure, delete.
- Create dialog: image tiles (Valkey 8.0 / Redis 7.2), preset tiles (**cache** → `allkeys-lru` + `NONE`, **queue** → `noeviction` + `AOF`, **persistent** → `noeviction` + `RDB`), memory limit, advanced eviction/persistence selects, project attach + auto-inject checkbox.
- Detail dialog: connection URL with reveal/copy (masked by default), live stats grid (used memory, total keys, clients, uptime) with refresh, settings summary, **Rotate Password** and **Restart** buttons.
- Configure dialog: memory/eviction/persistence → `PATCH` (container recreated, data preserved).
- Quota badge uses `usage.redisInstance`; the admin quota editor (`EditUserDialog`) and user list gained `maxRedisInstances`.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `REDIS_INSTANCE_CONFIG_DIR` | `<repo>/workspaces/redis-instances` | Host dir for per-instance `redis.conf` files (chmod 600) |
| `REDIS_INSTANCE_MAX_MEMORY_MB` | `1024` | Admin cap on a single instance's `memoryLimitMb` (400 `REDIS_MEMORY_LIMIT_TOO_HIGH` above it) |

`REDIS_CONTAINER_NAME` (F5.6) remains the **panel's own** Redis and is never used for tenant data.

## Tests

- `tests/test_redis_manager.py` — validation through the real stdin/stdout contract (identifiers, passwords, image allowlist, eviction/persistence/memory), line-by-line `redis.conf` assertions (requirepass, maxmemory, persistence modes, `rename-command` removals), `INFO` parsing, plus a Docker-gated create/stats/delete lifecycle test that skips without an engine. Wired into CI (`ci.yml`).
- `apps/api/src/modules/redis/service.test.ts` — create (quota cap, encrypted storage, secret-free audit), delete (record kept on teardown failure, 404 for foreign instances), stats, password rotation.

## Risks and mitigations

- **Orphaned container behind a deleted record** → delete tears down first, keeps the row on failure; create cleans up if the row insert fails.
- **Password leakage** → config-file-only storage (chmod 600), health/stats snippets read it in-container, audit logs and list responses never carry it.
- **Unpinned images / licence drift** → enum + server-side allowlist; `latest` rejected.
- **Tenant reaching the host or other tenants** → no published ports, `traefik-net` only, `protected-mode yes`, dangerous commands renamed away.
