# System Transactional Email (F5.23)

The panel's own outbound email: password resets, security alerts, quota warnings and backup-failure notices. It works with **no operator configuration** — mail is sent as `notifications@<your panel domain>` through the Postfix that ships with Vexlyx — and can be pointed at any external SMTP provider with a few environment variables.

This is separate from the customer mail-hosting stack ([Postfix](email/postfix.md), F4.1), which serves mailboxes for hosted domains. System email only *sends*, and only from the panel's own sender address.

## What gets emailed

| Event | Recipient | Trigger |
| --- | --- | --- |
| Password reset link | The account | `POST /api/auth/forgot-password` |
| Password changed | The account | A reset completes, or the user changes their password |
| Role changed | The account | An admin changes the role (`UserService.updateRole`) |
| 2FA enabled / disabled / reset | The account | `TwoFactorService` |
| Quota warning at 80% and 100% | The account | After a project, domain, database, mailbox or sub-account is created |
| Backup failed | Every admin | A backup job ends in `FAILED` |

"New login from an unrecognized location" is **not** included: it needs login history and IP geolocation, which the panel does not keep yet.

## How it works

```
 service code ──notifyUser()/notifyAdmins()──▶ BullMQ queue "system-email"
                                                      │ (5 attempts, exponential backoff)
                                                      ▼
                                          worker: renderEmail() → sendEmail()
                                                      │ nodemailer (SMTP)
                          ┌───────────────────────────┴──────────────────────────┐
                          ▼                                                      ▼
              bundled Postfix (default)                          external relay (EMAIL_SMTP_HOST)
              OpenDKIM signs notifications@MAIL_DOMAIN                 Resend, Postmark, SES, Mailgun, ...
```

- `modules/system-email/notifier.ts` is a module-level singleton, so any service sends a notification with one line and calls made before registration are silent no-ops. The notifier catches and structurally logs dispatch failures with the event and target (plus the recipient for user notifications), without logging template parameters or failing the business operation that triggered the email.
- Sending is always queued, so a slow or unreachable SMTP server never blocks a request. Failures are retried, logged, and shown on the admin card.
- `modules/system-email/templates.ts` holds one typed function per event returning subject, plain text and a minimal HTML body. There is no template builder by design. Links are built from `PANEL_DOMAIN` (or `CORS_ORIGIN`), never from a request's `Host` header.
- On API start (bundled transport only) `ensureSenderIdentity()` calls the existing `generate_dkim` command in `postfix_manager.py` for `MAIL_DOMAIN`, which is idempotent, so OpenDKIM signs panel mail. The panel domain is not a customer `Domain`, so no database row is created.

## Password reset

1. `POST /api/auth/forgot-password { email }` always answers `202` with the same body, whether or not the email exists, and is limited to 5 requests per 15 minutes per IP. Per account it sends at most one email a minute (a Redis key) and never locks the account.
2. A 32-byte random token is created; only its SHA-256 is stored in `password_reset_tokens`. Any earlier unused link for that user is deleted, so the newest link wins.
3. The email links to `/reset-password#token=…`. The token is in the URL **fragment**, so it never reaches server logs or `Referer` headers. The page reads it, then removes it from the address bar.
4. `POST /api/auth/reset-password { token, newPassword }` checks the hash, expiry (30 minutes) and that it is unused, then claims it atomically (`updateMany … usedAt: null`) so two simultaneous requests cannot both win.
5. On success the password is re-hashed with Argon2id, **every session of that user ends** (`destroyUserSessions`), there is **no auto-login**, two-factor stays enforced, a "password changed" email is sent, and `user.password_reset` is written to the audit log.

`changePassword` also ends the user's *other* sessions and sends the same notice.

**Admin accounts are not email-resettable** unless `ALLOW_ADMIN_EMAIL_RESET=true`. An admin is root-equivalent on the host, so a compromised mailbox must not be enough to take one over. Server-side admin recovery is tracked in issue #19.

## Configuration

All variables are optional. See `apps/api/.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMAIL_ENABLED` | `true` | Master switch. When `false`, nothing is queued. |
| `EMAIL_TRANSPORT` | `smtp` in production, `log` otherwise | `log` prints each message (including reset links) to the API log. Refused in production. |
| `MAIL_DOMAIN` | `PANEL_DOMAIN`, then `BASE_DOMAIN` (the production compose file sets it to the panel domain) | Domain of the sender address. |
| `MAIL_FROM` | `notifications@<MAIL_DOMAIN>` | Sender address. |
| `MAIL_REPLY_TO` | unset (the installer sets the admin email) | Where replies go. The sender address has no mailbox, so without this replies bounce. |
| `BUNDLED_SMTP_HOST` / `BUNDLED_SMTP_PORT` | `127.0.0.1` / `25` | Where the bundled Postfix is reached. The production compose file sets the host to `postfix`. |
| `EMAIL_SMTP_HOST`, `_PORT`, `_SECURE`, `_USER`, `_PASS` | unset (port `587`) | Use an external relay instead. User and password must be set together. |
| `ALLOW_ADMIN_EMAIL_RESET` | `false` | Allow password reset by email for admin accounts. |

The external-relay variables are named `EMAIL_SMTP_*` rather than `SMTP_*` because `SMTP_HOST` and `SMTP_PORT` are already used by the customer mail-hosting diagnostics.

### Why this sender address

Mail comes from the **panel (sub)domain**, e.g. `notifications@panel.example.com`, not the apex domain. A dedicated subdomain keeps the reputation of automated mail separate from your people's mail on the main domain. The local part is `notifications` rather than `noreply`, because mailbox providers (Outlook since 2024) treat no-reply senders less favourably; replies are redirected to the admin through `Reply-To`.

### Deliverability

Mail from your own server is only as trusted as the DNS behind it. For the bundled transport, publish an **SPF**, **DKIM** and **DMARC** record for `MAIL_DOMAIN`. **Settings → System Email** (admins) lists the exact values and checks them against public DNS, and the installer summary points there.

Two common blockers:

- **Outbound port 25 is blocked** by many VPS providers. If the status card shows connection errors, set `EMAIL_SMTP_HOST` to a provider's SMTP endpoint. A provider also gives you IP reputation you don't have to earn.
- **A new server IP has no reputation.** Expect early mail to land in spam until SPF/DKIM/DMARC pass and the IP warms up.

## Admin API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/system-email/status` | ADMIN only. Transport, sender, last success or error, required DNS records with a live check. |
| `POST` | `/api/system-email/test` | ADMIN only. Sends immediately (not queued) so the real error is returned. Audited as `system_email.test_sent`. |

## Data model

- `PasswordResetToken` — `tokenHash` (unique), `expiresAt`, `usedAt`, `requestIp`. Cascades with the user.
- `QuotaNotice` — one row per `(user, resource, level)` already warned about. Created when a warning is sent, removed when usage drops back under the threshold so it can fire again. Only a user's own limit is considered, not pooled reseller limits (F5.20).

## How to test

```bash
pnpm --filter @vexlyx/api test
```

Unit tests cover the templates, sender options, the token lifecycle (hashing, expiry, reuse, simultaneous use, newest-link-wins, admin gate), quota de-duplication and re-arming, response parity for known and unknown emails, 401/403 on the admin routes and the 429 rate limit.

By hand in development (`EMAIL_TRANSPORT=log` is the default): open `/forgot-password`, submit an email, and copy the link from the API log. To test real delivery, run the dev Postfix (`docker-compose up -d`) and set `EMAIL_TRANSPORT=smtp`.

## How to extend

To add an event: add its name to `SYSTEM_EMAIL_EVENTS` in `packages/shared/src/schemas/systemEmail.ts`, its params and template in `modules/system-email/templates.ts` (the compiler flags a missing template), then call `notifyUser(event, to, params)` or `notifyAdmins(event, params)` where it happens and add a test.
