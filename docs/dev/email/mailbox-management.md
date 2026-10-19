# Mailbox Management UI (F4.3)

> **Feature:** F4.3 — Mailbox Management UI
> **Status:** 🟢 COMPLETED
> **Package:** `@vexlyx/api`, `@vexlyx/dashboard`, `@vexlyx/shared`
> **Prisma Models:** `Domain`, `Mailbox`
> **Depends on:** F4.1 (Postfix SMTP), F4.2 (Dovecot IMAP)

---

## 1. Overview

F4.3 gives admins self-service mailbox provisioning on top of the `Mailbox` Prisma model that F4.1/F4.2 already synced into Postfix/Dovecot but never let anyone actually create through the UI.

- **Passwords are generated server-side** and shown exactly once, in a copy-to-clipboard dialog, right after create/reset — never re-displayed, never accepted from the client on create.
- **Quota is a fixed preset** (256MB / 512MB / 1GB / 5GB / 10GB / Unlimited), stored in `Mailbox.quota` as megabytes (`0` = unlimited).
- **Usage stats are real bytes on disk**, computed by walking each mailbox's Maildir directory — not an estimate.
- Every mutation (create/quota/reset/delete) re-syncs Postfix's virtual maps *and* Dovecot's passwd-file, so a mailbox is immediately usable without a separate manual "Sync with Postfix" click.

---

## 2. Architecture & Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Next.js Dashboard UI                      │
│  /mail → "Mailboxes" tab (MailboxesPanel.tsx)                 │
│  create / quota / reset-password / delete dialogs             │
└──────────────────────────────┬───────────────────────────────┘
                                │ HTTP / JSON
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                     Fastify API Server                        │
│  GET    /api/mailboxes            list + usage                │
│  POST   /api/mailboxes            create (returns password once)│
│  PATCH  /api/mailboxes/:id/quota  update quota                │
│  POST   /api/mailboxes/:id/reset-password                     │
│  DELETE /api/mailboxes/:id                                    │
└───────────────┬─────────────────────────────┬─────────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────────┐  ┌──────────────────────────────┐
│      PostgreSQL (Prisma)      │  │  MailboxService calls into     │
│  model Mailbox (address,      │  │  MailService.syncVirtualDomains│
│  password hash, quota)        │  │  (the same routine the F4.1    │
└───────────────────────────────┘  │  "Sync with Postfix" button    │
                                    │  uses) after every mutation    │
                                    └───────────────┬────────────────┘
                                                     ▼
                              system/python/postfix_manager.py
                                sync_virtual_domains(domains, mailboxes)
                              system/python/dovecot_manager.py
                                sync_mailboxes(mailboxes, domains)
                                get_usage(addresses)  ← real Maildir bytes
                                                     │
                     ┌───────────────────────────────┴───────────────────────────────┐
                     ▼                                                               ▼
     /etc/postfix/virtual_domains, virtual_mailbox_maps (+.lmdb)      /etc/dovecot/virtual/users (passdb+userdb)
     /etc/opendkim/KeyTable, SigningTable                              (ARGON2ID hash, quota rule)
                     │                                                               │
                     └──────────────────────────┬────────────────────────────────────┘
                                                 ▼
                          ./docker/mail-data/vhosts/<domain>/<local>/Maildir
                                  (shared bind mount, written by Postfix,
                                   read by Dovecot AND by get_usage)
```

`MailboxService` deliberately reuses `MailService.syncVirtualDomains(userId)` (from the F4.1 `mail` module) rather than a lighter partial sync — Postfix's `sync_virtual_domains` fully rewrites `virtual_domains`/`virtual_mailbox_maps` from whatever list it's given, so a mailbox mutation must always push the user's *complete* domain/mailbox set, not just the one domain that changed, or it would silently wipe out unrelated domains' entries.

---

## 3. API Contract

### `POST /api/mailboxes`
```json
// request
{ "localPart": "jane", "domainId": "clxyz...", "quota": 1024 }

// response (201)
{
  "mailbox": { "id": "...", "address": "jane@example.com", "domainId": "...", "hostname": "example.com", "quota": 1024, "status": "ACTIVE", "usedBytes": 0, "createdAt": "..." },
  "password": "S-v5wDdzvLhpPD01VOS16mDZ"   // shown once — not recoverable afterward
}
```

### `GET /api/mailboxes?domainId=...`
Returns `{ mailboxes: MailboxResponse[] }` with `usedBytes` populated from a single batched `get_usage` call (one Python spawn for the whole list, not one per mailbox).

### `PATCH /api/mailboxes/:id/quota` — `{ "quota": 5120 }` → `{ "success": true }`

### `POST /api/mailboxes/:id/reset-password` → `{ "password": "..." }` (new plaintext, one time)

### `DELETE /api/mailboxes/:id` → `204`

All routes require `app.requireAuth` and scope every query by `request.userId`.

---

## 4. Bugs Found & Fixed While Building This

Wiring real mailbox creation up to real Postfix + Dovecot surfaced **eight** pre-existing bugs in the F4.1/F4.2 mail stack — none of them were exercised before because nothing had ever actually created a mailbox and sent it real mail end-to-end. All are fixed; this section exists so nobody re-discovers them the hard way.

1. **`virtual_mailbox_maps` never recompiled.** It's an `lmdb:` table in `main.cf`; Postfix reads the compiled `.lmdb` file, not the text source. `sync_virtual_domains` wrote the text file and reloaded Postfix, but never ran `postmap` — so mailbox changes never took effect (`550 5.1.1 ... Recipient address rejected`). Fixed in `postfix_manager.py`.
2. **DKIM `KeyTable` stored a Windows host path.** `generate_dkim_keys` wrote `str(priv_file)` — a literal `D:\...\default.private` path on a Windows dev host — into OpenDKIM's `KeyTable`, which is read by OpenDKIM *inside the Linux container*. Fixed to always write the container-native `/etc/opendkim/keys/<domain>/<selector>.private`, and made the write idempotent so a stale entry self-heals on the next DKIM generate/lookup call.
3. **OpenDKIM caches its tables in memory.** Even with a correct `KeyTable`, OpenDKIM doesn't notice a plain file edit — it needs `SIGHUP`. Added `pkill -HUP opendkim` after every table write (`reload_opendkim()`).
4. **`.lmdb` file permission mismatch.** `postmap` runs via `docker exec` (root), producing a `root:root` mode `640` file — but actual delivery happens in Postfix's unprivileged `virtual` service (`postfix:postfix`), which then can't read it (`451 4.7.0`, log: `open database ...lmdb: Permission denied`). Fixed with `chmod 644` after every `postmap`, in both the live sync path and `entrypoint.sh` (so a fresh container boot doesn't reintroduce it).
5. **CRLF corruption from Windows Python.** `Path.write_text()` defaults to OS line endings — on Windows that's `\r\n`. Every config file this script writes for the *Linux* container was getting silently corrupted with embedded `\r` (`postfix/trivial-rewrite: fatal: match_list_parse: read file ...: No data available`). Fixed by adding `newline="\n"` to every text write in both `postfix_manager.py` and `dovecot_manager.py`.
6. **Docker Desktop Windows bind-mount flakiness.** Even with clean files, the shared bind mount (gRPC-FUSE/virtiofs) occasionally serves a transient read error for a moment right after a host-side write — the same class of issue already documented in `dovecot.conf` for Dovecot's index files. Postfix's `trivial-rewrite` has no retry logic: hitting this window once means Postfix throttles respawning it for up to 60s. Mitigated with a short settle delay before `postfix reload`.
7. **Wrong Maildir path order.** `virtual_mailbox_maps`'s right-hand side was built as `local/domain/` with no `Maildir` segment. Dovecot's `mail_location` (`dovecot.conf`) is `maildir:/var/mail/vhosts/%d/%n/Maildir` — **domain**, then **local part**, then a `Maildir` folder. Mail was landing on disk (Postfix reported success) at a path Dovecot's IMAP would never look in. Fixed the path builder to `domain/local/Maildir/`; the two already-misdelivered test messages were manually relocated (see git history around this fix if you need the recovery steps for a similar situation).
8. **Argon2 PHC parameter order.** Node's `argon2` package (`apps/api`, v0.45.1) encodes hashes as `$argon2id$v=19$m=...,p=...,t=...$salt$hash` — but Dovecot's ARGON2ID passdb parser requires the canonical `m=...,t=...,p=...` order and silently derives the wrong `t`/`p` values otherwise. The hash looks well-formed and Node's own `argon2.verify()` confirms it's correct (self-consistent within Node), but **`doveadm pw -t` reports "Password mismatch"** on the exact same hash — proven by reordering only the parameter string (same salt/digest) and watching verification flip from failing to passing. Fixed in `dovecot_manager.py`'s `_format_passwd_line` with a regex that reorders `m=X,p=Y,t=Z` → `m=X,t=Z,p=Y` before writing to the passwd-file. **This affects every Argon2id hash Dovecot ever consumes**, not just mailboxes — if a future feature writes to the Dovecot passwd-file from a different code path, route it through `_format_passwd_line` (or replicate the reorder) rather than writing hashes directly.

---

## 5. Testing & Verification

No automated test file exists yet for this module (unlike F4.1/F4.2's `tests/test_postfix_smtp.py` / `tests/test_dovecot_imap.py`) — everything below was verified manually against the live dev stack (`docker-compose up -d`) with real HTTP calls, real IMAPS connections, and real `doveadm`/`postqueue` inspection. Consider porting this into a `tests/test_mailbox_management.py` using the same `unittest` pattern as the sibling suites.

Manual verification sequence (all of this passed on the current codebase):
```bash
# 1. Create a mailbox
curl -b cookies.txt -X POST http://localhost:5000/api/mailboxes \
  -H "Content-Type: application/json" \
  -d '{"localPart":"jane","domainId":"<id>","quota":256}'
# → 201, { mailbox, password }

# 2. Sync (also happens automatically on every mutation)
curl -b cookies.txt -X POST http://localhost:5000/api/mail/sync

# 3. Real IMAPS login with the returned password (proves Argon2id order fix)
python -c "
import socket, ssl
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection(('127.0.0.1', 993)))
print(s.recv(200))
s.send(b'a1 LOGIN jane@example.com <password>\r\n'); print(s.recv(200))
"
# → "a1 OK ... Logged in"

# 4. Send real mail via the F4.1 test-send endpoint, confirm it lands correctly
curl -b cookies.txt -X POST http://localhost:5000/api/mail/test-send \
  -H "Content-Type: application/json" \
  -d '{"from":"admin@example.com","to":"jane@example.com","subject":"test","body":"hi","port":25,"useTls":false}'
docker exec vexlyx-dovecot doveadm mailbox status -u jane@example.com messages INBOX
# → "INBOX messages=1"

# 5. Usage stats reflect the real message
curl -b cookies.txt http://localhost:5000/api/mailboxes
# → usedBytes > 0

# 6. Quota is really wired to Dovecot's quota engine
docker exec vexlyx-dovecot doveadm quota get -u jane@example.com
# → Limit column matches quota * 1024 (KB)

# 7. Delete → inaccessible
curl -b cookies.txt -X DELETE http://localhost:5000/api/mailboxes/<id>
curl -b cookies.txt -X POST http://localhost:5000/api/mail/sync
# retry step 3's IMAPS login → "a1 NO [AUTHENTICATIONFAILED]"
```

Dev credentials for the seeded admin user: `admin@vexlyx.local` / `admin123` (`apps/api/prisma/seed.ts`).

---

## 6. How to Extend

- **F4.4 Webmail (Roundcube)**: no changes needed here — Roundcube just needs IMAP/SMTP pointed at `dovecot:143`/`postfix:587`, and mailboxes created through this feature are immediately usable.
- **F4.6 Aliases/forwarding**: this module only manages real mailboxes (`Mailbox` rows with a login). Aliases are a separate concept (`virtual_alias_maps`, currently unused) — don't conflate the two; an alias shouldn't get a `Mailbox` row or a password.
- **Suspend/reactivate**: `Mailbox.status` already supports `SUSPENDED`/`DELETED`, but the UI currently only exposes `ACTIVE` mailboxes with a delete action. A suspend toggle would need `sync_mailboxes` (dovecot) and `sync_virtual_domains` (postfix) to both skip non-`ACTIVE` mailboxes when building their maps — neither currently filters on status.
- **Custom (non-preset) quotas**: `QuotaPresetSchema` is a closed `z.union` of literals by design (per-project decision, see conversation history) — if a future need arises for arbitrary quotas, that schema and the `MailboxesPanel` quota `Select` are the two places to change; the backend/Dovecot plumbing already accepts any integer megabyte value.
- If you touch `dovecot_manager.py`'s password-writing path again, **keep the Argon2 parameter reorder** (`_ARGON2_PARAM_ORDER_RE` in `_format_passwd_line`) — removing it silently breaks every IMAP login without any error at write time, only at login time.
