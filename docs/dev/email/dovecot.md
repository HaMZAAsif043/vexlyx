# Dovecot IMAP Server (F4.2)

> **Feature:** F4.2 — Dovecot IMAP Server
> **Status:** 🟢 COMPLETED
> **Package:** `@vexlyx/api`, `@vexlyx/dashboard`, `@vexlyx/shared`
> **Prisma Models:** `Domain`, `Mailbox`
> **Infrastructure:** Dovecot 2.3.x, Maildir++ storage, ARGON2ID passdb, TLS on 993

---

## 1. Overview

Dovecot IMAP Server provides incoming mail access (IMAP) for every mailbox managed in Vexlyx, serving the same Maildir storage that Postfix (F4.1) delivers into.

Production IMAP/IMAPS uses the same publicly trusted certificate as Postfix.
The production Compose overlay mounts `docker/mail-data/certs` read-only at
`/etc/dovecot/certs`; the installer synchronizes that pair from Traefik's ACME
store and keeps it current with the `vexlyx-mail-tls.timer` systemd timer.
Container-generated self-signed certificates are retained only for local
development.

Vexlyx decouples IMAP access into:
1. **A single flat passwd-file acting as both passdb and userdb** (`/etc/dovecot/virtual/users` in Docker), synchronized from the `Mailbox` table by `dovecot_manager.py` — no live database connection from Dovecot itself, matching Postfix's own decoupled virtual-domain sync philosophy from F4.1.
2. **ARGON2ID password verification**, consistent with CLAUDE.md's Argon2id-everywhere rule. Mailbox passwords are stored pre-hashed (PHC format) and simply get an `{ARGON2ID}` scheme prefix when written to the passwd-file.
3. **Cross-container SASL integration**: Postfix's submission port (587) authenticates against Dovecot's userdb over an internal TCP auth listener (`inet:dovecot:12345`) rather than a shared unix socket, since the two services run in separate containers.
4. **Maildir++ quota enforcement**, per-mailbox, driven by a `userdb_quota_rule` extra field written alongside each passwd-file entry — kept in sync with `Mailbox.quota` (interpreted in **megabytes**).
5. **Hybrid dev & production parity**: a full containerized dev environment in `docker-compose.yml` (`vexlyx-dovecot`) exposing ports 143/993, alongside a dedicated bare-metal production installer (`system/scripts/setup-dovecot.sh`).

---

## 2. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Next.js Dashboard UI                     │
│  - /mail → "IMAP Service (Dovecot)" status card              │
│  - Sync with Postfix button also syncs Dovecot mailboxes    │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / JSON
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Fastify API Server                      │
│  - GET  /api/mail/status  → { ...smtp, imap: {...} }         │
│  - POST /api/mail/sync    → syncs Postfix AND Dovecot        │
└───────────────┬──────────────────────────────┬──────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────────┐ ┌───────────────────────────┐
│      PostgreSQL (Prisma)      │ │  system/python/           │
│  - model Domain               │ │  dovecot_manager.py       │
│  - model Mailbox (quota, pw)  │ │  - sync_mailboxes         │
└───────────────────────────────┘ │  - status probing         │
                                  └─────────────┬─────────────┘
                                                │ Writes
                                                ▼
                          /etc/dovecot/virtual/users (passwd-file: passdb + userdb)
                                                │
                                                ▼
                                  ┌───────────────────────────┐
                                  │      Dovecot Engine       │
                                  │ - Port 143 (IMAP)         │
                                  │ - Port 993 (IMAPS, TLS)   │
                                  │ - Port 12345 (SASL/auth)  │◄── Postfix (F4.1) authenticates
                                  │   for submission (587)     │    SMTP submission here
                                  └─────────────┬─────────────┘
                                                │ Reads/writes
                                                ▼
                          ./docker/mail-data/vhosts (shared bind mount)
                          Maildir tree, also written to by Postfix's
                          virtual delivery agent
```

---

## 3. Configuration Specifications

### Dovecot `dovecot.conf` (`docker/dovecot/dovecot.conf`)

Key directives:
```text
protocols = imap

mail_location = maildir:/var/mail/vhosts/%d/%n/Maildir:INDEX=/var/indexes/%d/%n:CONTROL=/var/indexes/%d/%n
mail_home = /var/mail/vhosts/%d/%n
mail_uid = 5000
mail_gid = 5000

passdb {
  driver = passwd-file
  args = scheme=ARGON2ID username_format=%u /etc/dovecot/virtual/users
}
userdb {
  driver = passwd-file
  args = username_format=%u /etc/dovecot/virtual/users
}

disable_plaintext_auth = yes
ssl = required
ssl_cert = </etc/dovecot/certs/cert.pem
ssl_key = </etc/dovecot/certs/key.pem

mail_plugins = $mail_plugins quota
plugin {
  quota = maildir:User quota
}

service imap-login {
  inet_listener imap { port = 143 }
  inet_listener imaps { port = 993; ssl = yes }
}

service auth {
  inet_listener { port = 12345 }
}
```

**Why `INDEX=`/`CONTROL=` point elsewhere:** Dovecot's `dovecot-uidlist` rewrite does an open → fstat → rename-temp-file sequence. On Docker Desktop's Windows bind-mount filesystem (virtiofs/gRPC-FUSE), that sequence reliably fails with `ENOENT` on the shared `./docker/mail-data/vhosts` mount. Indexes and control files are Dovecot's private, disposable cache/metadata — safe to keep on a container-local path (`/var/indexes`) — only the actual Maildir message files need to be shared with Postfix. This was discovered and fixed during F4.2 development; without it, `SELECT INBOX` fails on every login.

**Why uid/gid 5000:5000 everywhere:** Postfix and Dovecot are separate containers writing to the *same* bind-mounted Maildir tree. Both must use identical numeric uid/gid — chosen as 5000 (rather than reusing whatever a package's auto-created system user gets) specifically to avoid collision with uids Alpine's `apk add dovecot`/`apk add postfix` might allocate to their own internal service accounts. See `docker/postfix/main.cf`'s `virtual_uid_maps`/`virtual_gid_maps` for the matching Postfix-side setting.

### Postfix SASL integration (`docker/postfix/main.cf`, added in F4.2)
```text
smtpd_sasl_auth_enable = yes
smtpd_sasl_type = dovecot
smtpd_sasl_path = inet:dovecot:12345
```
Postfix and Dovecot are separate containers, so a shared unix socket (the traditional bare-metal approach) isn't available — Dovecot exposes its auth service over an internal TCP listener instead. The production installer (`setup-dovecot.sh`) uses the traditional unix socket at `/var/spool/postfix/private/auth` since bare-metal Postfix and Dovecot share a filesystem.

### Virtual mailbox passwd-file (`docker/dovecot/config/users`)
One line per mailbox, format `user:password:uid:gid:gecos:home:shell:extra`:
```text
test@vexlyx.local:{ARGON2ID}$argon2id$v=19$...:5000:5000::::userdb_quota_rule=*:storage=1024M
```
- Regenerated by `dovecot_manager.py sync_mailboxes`, scoped per-domain: entries for domains passed in are fully replaced (upsert), entries for domains *not* in the sync scope (e.g. the dev fixtures below) are left untouched.
- The users file is runtime data, excluded from Git and the image build context. Only an empty directory placeholder ships in a fresh checkout.
- `docker/dovecot/entrypoint.sh` seeds each missing dev fixture only when `VEXLYX_SEED_DEV_FIXTURES=true`: `test@vexlyx.local` / `admin@vexlyx.local`, password **`vexlyx-dev`**, 1024M quota. The image defaults to disabled; development Compose explicitly opts in.
- Production refuses startup with exposed fixture credentials already in the file. See [safe upgrade and credential remediation](mail-credential-remediation.md) **before updating an existing deployment**.

---

## 4. API Integration

`GET /api/mail/status` (existing F4.1 endpoint) now returns an additional `imap` field:
```json
{
  "service": "postfix",
  "status": "active",
  "...": "...",
  "imap": {
    "service": "dovecot",
    "status": "active",
    "port143Open": true,
    "port993Open": true,
    "tlsEnforced": true,
    "saslAuthConnected": true,
    "activeMailboxesCount": 2,
    "lastChecked": "2026-09-05T12:00:00.000Z"
  }
}
```

`POST /api/mail/sync` (existing F4.1 endpoint) now also pushes each domain's `Mailbox` rows into Dovecot, returning an added `mailboxesSynced` count:
```json
{ "success": true, "syncedCount": 3, "domains": ["example.com"], "mailboxesSynced": 5 }
```

**Contract for F4.3 (Mailbox Management UI):** `Mailbox.password` is expected to already be an Argon2id PHC-format hash (`$argon2id$v=19$...`) when creating/updating a mailbox — `dovecot_manager.py` only adds the `{ARGON2ID}` scheme prefix, it does not hash. `Mailbox.quota` is interpreted in **megabytes**.

---

## 5. Testing & Verification

Run the dedicated test suite:
```bash
python -m unittest tests.test_dovecot_imap -v
```

Covered tests:
- `TestDovecotSystemManager`: `sync_mailboxes` writes correct passwd-file lines, preserves out-of-scope domains, removes deleted mailboxes, and `status` returns the full `ImapStatusResponse` shape.
- `TestDovecotConfigurations`: validates `dovecot.conf`, `Dockerfile`, `entrypoint.sh`, Postfix's SASL wiring in `main.cf`, `docker-compose.yml` wiring, and the production installer script.
- `TestDovecotLiveImaps` (skipped gracefully if the stack isn't running): a **live** IMAPS login against the seeded `test@vexlyx.local` fixture, and a **live** SMTP AUTH over port 587 proving Postfix successfully authenticates against Dovecot's SASL backend.

Manual verification commands are in the F4.2 test-plan conversation; the short version:
```bash
docker compose up -d --build postfix dovecot
python -m unittest tests.test_dovecot_imap -v
```

---

## 6. How to Extend

- **F4.3 Mailbox Management UI**: build `POST/GET/DELETE /api/mailboxes` on top of the existing `Mailbox` Prisma model. Hash new passwords with Argon2id (Node `argon2` package — confirm with the user before adding it, per CLAUDE.md's no-new-dependencies rule) and store the PHC string directly in `Mailbox.password`; the existing `POST /api/mail/sync` call already picks up any `Mailbox` row and pushes it into Dovecot.
- **F4.4 Webmail (Roundcube)**: point Roundcube's IMAP/SMTP config at `dovecot:143`/`postfix:587` on the shared `default` Docker network — no changes needed here.
- **F4.6 Email Forwarding & Aliases / vacation responder**: Dovecot's Pigeonhole Sieve plugin (`dovecot-pigeonhole` on Alpine) is not installed yet; add it to `docker/dovecot/Dockerfile` and a `sieve` block to `dovecot.conf` when building that feature.
- If a future feature needs a **quota-exceeded warning to the user**, `dovecot_manager.py`'s `status` command already counts mailboxes from the passwd-file — extend it to also shell out to `doveadm quota get -u <user>` for per-mailbox usage.
