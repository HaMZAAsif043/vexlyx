# Audit Log (F5.18)

> **Status:** 🟢 COMPLETED
> **Feature:** A generic, admin-only audit trail for security/admin-sensitive mutations across the panel.

---

## What It Does

Before F5.18, Vexlyx had no record of who changed a role, deleted a user, modified a firewall rule, or restored a backup — only scattered fields like `FirewallRule.createdBy`. With admin/reseller user-management (F5.5–F5.8) live, an ADMIN could silently change any user's role or delete an account with no trail.

F5.18 adds:

- A generic `AuditLog` table (`audit_logs`) recording actor, action, target, and an explicit before/after metadata diff.
- A shared `AuditLogService.log(...)` helper, called explicitly at the end of each audited mutation (not auto-captured via Prisma middleware).
- Coverage for: user role/quota changes, user create/delete, firewall rule/policy changes, backup restore/delete, file permission changes and archive extract/compress (F5.24), and create/delete for projects, domains, databases, and mailboxes.
- An admin-only `/audit-log` page — filterable by actor, action, and date range, server-side paginated.

---

## Architecture

```
Browser (/audit-log — AuditLogPage / AuditLogTable)
  │  REST: GET /api/audit-log?actorId=&action=&dateFrom=&dateTo=&page=&pageSize=
  ▼
apps/api/src/modules/audit-log/{routes,service,schema}.ts
  │  Prisma: AuditLog rows (read-only from the API — no public write endpoint)
  ▼
Postgres — audit_logs table
```

Writes happen the other direction: any service that performs an audited mutation (users, firewall, backups, projects, domains, databases, mailboxes) holds a constructor-injected `AuditLogService` instance and calls `.log(...)` once the underlying Prisma write has succeeded. There is deliberately no `POST /api/audit-log` — an entry can only ever be created by code running inside the API process, never forged through the HTTP API.

## `AuditLogService.log(actorId, action, target, metadata?)`

```ts
await this.auditLog.log(
  userId,
  "user.role_changed",
  { type: "User", id: targetUserId },
  { before: { role: oldRole }, after: { role: newRole } },
);
```

- **`actorId`** — just the user id. The service looks up that user's current `email` and `role` itself (not trusted from the caller/session), and snapshots them onto the row (`actorEmail`, `actorRole`). This is deliberate: if the actor's account is later deleted, the audit entry stays fully legible — `actorId` has no foreign-key relation for exactly this reason.
- **`action`** — a dot-namespaced string from `AUDIT_ACTIONS` (`packages/shared/src/schemas/audit-log.ts`), e.g. `"firewall.rule_deleted"`. Kept as a documented `const` array rather than a DB enum or Prisma enum, so a new call site never needs a migration.
- **`target`** — `{ type: string; id: string }`, e.g. `{ type: "FirewallRule", id: rule.id }`.
- **`metadata`** — optional `{ before?, after? }`. **Must only ever be an explicit whitelist of the fields that changed**, assembled by the call site — never a raw request body or full database record. This is what keeps passwords, DB credentials, and encrypted env vars out of the audit trail; there is no generic redaction filter because there is nothing generic to redact.

`log()` never throws into the caller — a write failure is caught and logged via the injected `FastifyBaseLogger`, so an audit-log outage can never block the underlying action (e.g. a firewall rule delete still succeeds even if the audit insert fails).

## Wiring a new call site

1. Constructor-inject `AuditLogService` into the feature's service (see `modules/users/service.ts` or `modules/firewall/service.ts` for the required pattern; `modules/domains/service.ts` and `modules/databases/service.ts` take it as an **optional** constructor param instead, because another service — `SslService` / `WordpressService` — constructs a second instance of them purely to reuse internal helpers, with no audit-relevant calls).
2. Instantiate it once in the module's `routes.ts` alongside the feature service: `const auditLog = new AuditLogService(app.prisma, app.log);`.
3. Call `this.auditLog.log(...)` right after the Prisma mutation that needs auditing succeeds, inside the service method — not in the route handler — so the before/after values are naturally at hand.
4. Add the new action string to `AUDIT_ACTIONS` in `packages/shared/src/schemas/audit-log.ts`.

## Scheduled/system-initiated deletes

`BackupService.delete(id, actorId?)` takes an **optional** `actorId`. The scheduled retention-cleanup path (`purgeExpired` → `this.delete(s.id)`) calls it with no actor — that's a system action, not a user one, so no audit entry is written for it. Only the `DELETE /api/backups/:id` route (an explicit admin action) passes `request.userId!` and gets logged.

## Frontend

`/audit-log` (`apps/dashboard/src/app/(panel)/audit-log/page.tsx` → `AuditLogPage.tsx` → `AuditLogTable.tsx`) mirrors the `/users` page's structure: server-enforced role gate (`requireRole("ADMIN")` on the API) mirrored by a client-side `user.role !== "ADMIN"` check. Unlike `/users`' `UserList` (unpaginated), this page is server-side paginated (`useAuditLog` hook, 25 rows/page) with filters for action (dropdown of `AUDIT_ACTIONS`), date range, and actor — clicking an actor's email in the table filters the list to that actor, shown as a dismissible badge.

---

## How To Test

1. As ADMIN, change a user's role (`/users`) → `/audit-log` shows a `user.role_changed` entry with the correct actor, old role, and new role.
2. As RESELLER, delete your own sub-account → the entry is attributed to the reseller (role `RESELLER`), not any admin.
3. Add/remove a firewall rule → `firewall.rule_created` / `firewall.rule_deleted` entries appear.
4. Restore or delete a backup snapshot → entries appear; letting the scheduled retention job auto-delete an expired snapshot produces **no** entry (system action).
5. Create/delete a project, domain, database, or mailbox → entries appear for each.
6. On `/audit-log`, filter by action, by date range, and by clicking an actor's email — confirm each narrows results, and that pagination controls move between pages correctly.
7. Inspect a few `metadata` values in Postgres (`select metadata from audit_logs`) — confirm none ever contains a password, DB credential, or other secret value.

## Extending

Coverage for F5.18 was deliberately scoped to create+delete for projects/domains/databases/mailboxes plus the full set for users/firewall/backups. Broader coverage (updates, redeploys, DNS/SSL changes, mailbox password resets, etc.) is a natural, incremental follow-up — each new call site is a one-line `this.auditLog.log(...)` addition per the pattern above, not a redesign.
