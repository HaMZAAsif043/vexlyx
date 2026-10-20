# Email Forwarding & Aliases (F4.6)

> Runtime storage and synchronization now use [persistent mail state](mail-state.md). The original single-file mounts and settle-delay workaround described below are historical; follow the linked guide for current deployment and recovery commands. Activation failures return HTTP 503 after a saved database change and must be corrected and retried.

## What it does

Lets a user forward mail from an address (`sales@domain.com`) to one or more real destination mailboxes, and configure a single catch-all address per domain (`@domain.com`) that receives anything not otherwise matched. This is the first developer doc for the mail subsystem — F4.1–F4.5 (Postfix, Dovecot, mailbox CRUD, webmail, SPF/DKIM/DMARC) are documented only in code comments.

**Out of scope:** vacation/auto-reply responders are tracked separately as F4.7, since they require Dovecot Pigeonhole (Sieve), which isn't installed.

## Architecture

- **Prisma:** `VirtualAlias` model (`apps/api/prisma/schema.prisma`) — `source` (unique, e.g. `sales@domain.com` or `@domain.com` for catch-all), `destinations` (Postgres native `String[]`), `isCatchAll`, scoped to a `User` and `Domain` with cascade delete.
- **API:** `apps/api/src/modules/aliases/` (`schema.ts`, `service.ts`, `routes.ts`) — mirrors `apps/api/src/modules/mailboxes/` exactly. `AliasService` verifies domain ownership before every write, and calls `MailService.syncVirtualAliases(userId)` after each mutation (non-fatal on sync failure — the DB write already succeeded).
- **Sync:** `MailService.syncVirtualAliases` (`apps/api/src/modules/mail/service.ts`) reads all of a user's `VirtualAlias` rows and calls `postfix_manager.py sync_virtual_aliases` via the existing `runPostfixManager` child-process bridge.
- **Postfix:** `system/python/postfix_manager.py`'s `sync_virtual_aliases()` writes `docker/postfix/config/virtual_alias_maps`, one line per alias: `source\tdest1,dest2` (Postfix's native comma-separated RHS for multi-destination forwarding).

`virtual_alias_maps` was already wired into the stack before this feature (`main.cf`'s `virtual_alias_maps = lmdb:/etc/postfix/virtual_alias_maps`, and both `docker/postfix/entrypoint.sh` and `system/scripts/setup-postfix.sh` already `touch`/`postmap`/`chmod` it at boot) — nothing ever wrote alias data into it until now.

### Two infrastructure gaps found and fixed during F4.6 testing

1. **`docker-compose.yml` had no bind mount for `virtual_alias_maps`.** `virtual_domains` and `virtual_mailbox_maps` were both bind-mounted from `docker/postfix/config/`, but the alias map was missing from the `postfix` service's `volumes:` list — so the container had its own empty, boot-time-only copy of the file, completely disconnected from the host file `postfix_manager.py` writes to. Every alias sync succeeded on the host side and reported success, but the container never saw it. Fixed by adding `./docker/postfix/config/virtual_alias_maps:/etc/postfix/virtual_alias_maps` to `docker-compose.yml`.
2. **`entrypoint.sh`'s boot-time `chmod 644` on the compiled `.lmdb` files could silently fail.** `postmap` and `chmod` ran back-to-back with no delay; on a Windows Docker Desktop bind mount, the just-written `.lmdb` file isn't always immediately stat-able, so the chmod occasionally failed and was swallowed by the trailing `|| true`, leaving both `virtual_mailbox_maps.lmdb` and `virtual_alias_maps.lmdb` root-only (`640`) after a fresh container start. Symptom: Postfix queues the message fine, then bounces it with `(mail system configuration error)` because the unprivileged `virtual` delivery agent can't read its own lookup table. Fixed by adding the same `sleep 0.3` settle delay already used in `postfix_manager.py`'s sync functions, before the boot-time chmod in `entrypoint.sh`.

Both were latent since F4.1/F4.2 (they affect `virtual_mailbox_maps` too, not just aliases) but went unnoticed because `MailService.syncVirtualDomains` re-runs `postmap`+`chmod`+`reload` on every mailbox/domain mutation, which happened to land after the boot-time race had already resolved. A cold container start with no subsequent sync was the condition that exposed it — worth remembering if mail delivery ever silently fails right after `docker compose up`.

## Design decisions

- **Catch-all is capped at one per domain, enforced by rejection, not replacement.** `AliasService.create` throws `CATCH_ALL_EXISTS` (409) naming the existing alias if a second catch-all is attempted for the same domain. This matches the explicit-validation style used elsewhere in Vexlyx (e.g. `MAILBOX_EXISTS`) — silently overwriting an existing catch-all would be a surprising, hard-to-audit side effect.
- **Aliases don't require a Mailbox to exist on the domain.** Only `Domain` ownership is checked, since destinations can be arbitrary external addresses and Postfix's `virtual_alias_maps` is independent of `virtual_mailbox_maps`.
- **The permission dance:** `docker exec ... postmap` runs as root inside the container, producing a root-owned `.lmdb` file — but actual delivery happens in Postfix's unprivileged `virtual` service (running as `postfix:postfix`). Without the `chmod 644` step after every `postmap`, delivery silently fails with "Permission denied" even though the lookup table itself is correct and `postfix reload` succeeds. This is the same trap `virtual_mailbox_maps` already had; `sync_virtual_aliases` repeats it deliberately.
- **The 0.3s settle delay** before `postmap`/`reload` works around a Docker Desktop Windows bind-mount (gRPC-FUSE/virtiofs) flakiness where a file read immediately after a host-side write can transiently fail. Same workaround already used in `sync_virtual_domains`.

## How to test

1. `pnpm db:migrate dev --name add_virtual_alias_model` (from `apps/api`).
2. `pnpm dev` to bring up the dashboard, API, and Docker services.
3. In the Mail page's **Aliases** tab, create a forwarding alias (e.g. `sales` → `you@yourdomain.com`) — confirm it appears in the table and `docker/postfix/config/virtual_alias_maps` gets the new line.
4. Send a test email to the alias address via the existing "Send Test Email" flow (Domains & Email Auth tab) and confirm delivery to the destination mailbox's Maildir.
5. Create a catch-all for the same domain, then attempt a second one — confirm it's rejected with a clear `CATCH_ALL_EXISTS` error.
6. Delete an alias and confirm the corresponding line disappears from `virtual_alias_maps` after the next sync.

## How to extend

- Multi-destination editing after creation is exposed via `PATCH /api/aliases/:id/destinations` (`useAliases().updateAliasDestinations`) but not yet wired into the dashboard UI — the table only supports create/delete today.
- A future vacation auto-responder (F4.7) would live alongside this as a separate Prisma model and Dovecot Sieve script generator; it is a materially different subsystem (Dovecot-side, not Postfix-side) and should not be bolted onto `VirtualAlias`.
