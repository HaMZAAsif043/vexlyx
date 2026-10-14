# Service Status Dashboard (F5.6)

> **Status:** 🟢 COMPLETED
> **Feature:** Live status, start/stop/restart controls, and a log tail for Postfix, Dovecot, CoreDNS, PostgreSQL, and Redis, plus a read-only Docker daemon row.

---

## What It Does

F5.6 adds a `/services` page to the Vexlyx dashboard (ADMIN-only) that:

- **Shows live status** for the five containers Vexlyx's hosting stack runs (Postfix, Dovecot, CoreDNS, PostgreSQL, Redis), pushed over Socket.io so the row flips within ~10 seconds of the container's real state changing, with a REST poll fallback when the socket isn't connected.
- **Shows Docker daemon reachability** (`docker info`) as a separate, read-only card. It has no start/stop/restart controls — restarting the daemon would take down every other container this panel runs, including its own Postgres/Redis.
- **Start/stop/restart** any of the five managed services. Stop and restart require confirming in a dialog first (these are shared, server-wide services, not a single user's project container); start does not.
- **Shows recent logs** for a service on demand — a static tail (`docker logs --tail`), refreshed manually, not a live stream.

---

## Architecture

Every managed service already runs as its own Docker container (see `docker-compose.yml`), so — unlike Firewall (F5.4), which needed a privileged helper container to reach the real host `iptables` — this feature is plain `docker` CLI calls against a container name, using the same bind-mounted-socket "Docker-outside-of-Docker" pattern `docker_manager.py`/`system_monitor.py` already rely on.

```
Browser (Services page)
  │  REST (initial load, actions) + Socket.io (subscribe:services / services:status)
  ▼
apps/api/src/modules/services/{routes,service,socket,schema}.ts
  │  spawn(python, service_status_manager.py) — stdin/stdout JSON, one call per command
  ▼
system/python/service_status_manager.py
  │  docker inspect / docker start|stop|restart / docker logs --tail N
  │  docker info (daemon reachability)
  ▼
Host Docker daemon (bind-mounted socket)
```

### Key Files

| File | Purpose |
|------|---------|
| `system/python/service_status_manager.py` | `status`/`start`/`stop`/`restart`/`logs` commands against a container-name whitelist |
| `apps/api/src/modules/services/service.ts` | Spawns the Python script; maps `ServiceName` → env-configured container name |
| `apps/api/src/modules/services/routes.ts` | REST endpoints (`GET /`, `POST /:name/start\|stop\|restart`, `GET /:name/logs`) |
| `apps/api/src/modules/services/socket.ts` | Socket.io room `"services"`, 10s push interval, mirrors `monitoring/socket.ts` |
| `apps/api/src/config/env.ts` | `POSTFIX_CONTAINER_NAME` / `DOVECOT_CONTAINER_NAME` / `COREDNS_CONTAINER_NAME` / `REDIS_CONTAINER_NAME` (plus the existing `POSTGRES_CONTAINER_NAME`) |
| `packages/shared/src/schemas/serviceStatus.ts` | Zod schemas shared between API and dashboard |
| `apps/dashboard/src/hooks/useServices.ts` | `useServices` (status + actions, socket-backed) and `useServiceLogs` (on-demand tail) |
| `apps/dashboard/src/components/services/` | All UI components |
| `apps/dashboard/src/app/(panel)/services/page.tsx` | Next.js route |

No Prisma model was added — status is live-only, unlike Monitoring (F-series) which persists history to `MetricSnapshot`.

---

## Access Control (#65)

Service health is host-wide, so it is **ADMIN only on both transports**: `GET /api/services` uses `requireRole("ADMIN")`, and the Socket.io `subscribe:services` handler applies the same rule with a fresh role lookup (`createSocketAuthorizer`, `apps/api/src/plugins/socket-auth.ts`). A non-admin (or unauthenticated, unknown, or lookup-failed) socket is not joined to the `services` room, no status is collected for it, and it receives `services:forbidden` (`{ error, code: "FORBIDDEN_ROLE", details }`). Tests: `apps/api/src/modules/services/socket.test.ts`.

**Adding a new privileged room?** Declare its access rule once (see `modules/services/access.ts`, `modules/backups/access.ts`) and use that same constant for both the HTTP guard and the `subscribe:*` handler, so the two cannot drift. Gate the handler with `authorizeSocketSubscription` and a per-socket `SubscriptionGate`: the role lookup is asynchronous, and a client that leaves while it is pending must not be joined (or have a push timer started) after its cleanup already ran.

## Python Script (`service_status_manager.py`)

**Protocol:** Same as `docker_manager.py`/`firewall_manager.py`/`system_monitor.py` — JSON payload on stdin, one JSON response on stdout, exit code 0/1.

**Commands:**

- `status` — for every container name in `payload["containers"]`, `docker inspect --format '{{.State.Status}}|{{.State.StartedAt}}'`; maps Docker's raw state (`running` / `exited`, `created`, `dead`, `paused` / anything else) to `running` / `stopped` / `unknown`. Also runs `docker info` to report Docker daemon reachability.
- `start` / `stop` / `restart` — take `{ command, container, containers }`. `container` **must** be present in the `containers` whitelist (the API's own env-configured container names) or the script fails with `UNKNOWN_CONTAINER` — this is what stops a compromised or buggy caller from being used to control containers Vexlyx doesn't manage.
- `logs` — `docker logs --tail N <container>` (stdout+stderr combined, same whitelist check).

**Container whitelist:** built by `service.ts` from env config (`POSTFIX_CONTAINER_NAME` etc.) and sent as `payload.containers` on every call — the Python script never trusts an arbitrary container name on its own.

---

## How to Test

1. **View status** — open `/services` as an ADMIN user; all five service cards plus the Docker daemon card should show "Running" (assuming `docker-compose up -d` is running).
2. **Live push** — from a terminal, `docker stop vexlyx-postfix`; the Postfix card should flip to "Stopped" within ~10 seconds without touching the page (proves the socket push works, not just the REST fallback).
3. **Start/stop/restart** — click Restart on Postfix → confirm in the dialog → card goes to "Stopped" then back to "Running" as the container restarts.
4. **Logs** — click "Logs" on any service → recent lines appear; click refresh after generating new log output (e.g. `docker restart vexlyx-dovecot`) → new lines appear after a manual refresh.
5. **Docker daemon row** — confirm it has no Start/Stop/Restart buttons, only a status badge.
6. **Access control** — log in as a non-ADMIN user → "Services" is absent from the sidebar and `GET /api/services` returns 403.

---

## How to Extend

- **More services (MySQL, Traefik, Roundcube, Adminer):** add the container name to `CONTAINER_NAMES` in `apps/api/src/modules/services/service.ts`, a matching `ServiceName` enum value + env var, and a `SERVICE_LABELS` entry in `apps/dashboard/src/components/services/ServicesPage.tsx`. No Python script changes needed — `status`/`start`/`stop`/`restart`/`logs` already operate on whatever's in the `containers` whitelist.
- **Live-follow logs:** the current viewer is a static tail; a live stream would follow `docker_manager.py`'s `logs_follow` pattern (a long-lived `docker logs --follow` subprocess piping lines back as they arrive) plus a Socket.io room per service, similar to how project deploy logs stream today.
- **Persisted status history:** if a "was Postfix down at 3am" view is ever needed, add a `ServiceStatusSnapshot`-style Prisma model and a BullMQ repeatable job, mirroring `MetricSnapshot`/`runMetricsCollectorJob` in the Monitoring module.
