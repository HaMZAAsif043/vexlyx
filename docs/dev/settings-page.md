# Panel Settings Page (F5.11)

> **Status:** 🟢 COMPLETED
> **Feature:** `/settings` — account info, self-service password change, and (ADMIN-only) the DNS records/public-IP reference from F5.9.

---

## What It Does

- `/settings` no longer 404s. It's linked from the Sidebar's bottom nav (already wired, unchanged) and accessible to every authenticated role — no `roles` restriction, matching how the Sidebar link itself was never role-gated.
- **Account card:** read-only name, email, role. Editing wasn't in scope for this pass — see "How to Extend".
- **Change Password card:** self-service form (current password + new password + confirm). On success, the current session stays logged in; the old password simply stops verifying everywhere else, since login re-checks the hash on every attempt rather than caching anything.
- **DNS Records & Public IP card:** ADMIN-only (both client-side — the section isn't rendered for other roles — and server-side, since `GET /api/system/dns-info` itself is ADMIN-gated). Shows the server's public IP and every DNS record from F5.9, each with a copy-to-clipboard button, plus a manual refresh (`RefreshCw`, 600ms spin, per CLAUDE.md's refresh-button convention).
- **Setup instructions + live verification (UX follow-up, same pass):** a short blurb tells the admin to add each record using its displayed type. The list includes application A records and the hosted-mail A/MX pair. A **Verify DNS** button triggers real cross-resolver A or MX lookups (`POST /api/system/dns-info/verify`) so propagation can be confirmed inside the panel. Each record gets a Live / Not pointed here yet / Not found badge.
- **GitHub card (F5.29):** administrators create or replace the panel-wide GitHub App; every authenticated user can link and disconnect their own account or organization installations. App credentials are never rendered. See [GitHub Integration](github-integration.md).

---

## Architecture

```
apps/dashboard/src/app/(panel)/settings/page.tsx
  └── apps/dashboard/src/components/settings/SettingsPage.tsx
        ├── useAuth()          — user info + changePassword()
        └── useDnsInfo(isAdmin) — GET /api/system/dns-info + POST .../verify, gated by role client-side

apps/api/src/modules/auth/
  routes.ts   — POST /api/auth/change-password (requireAuth, rate-limited 5/15min)
  service.ts  — AuthService.changePassword(userId, data)
  schema.ts   — re-exports ChangePasswordSchema

apps/api/src/modules/system/
  routes.ts   — GET /api/system/dns-info, POST /api/system/dns-info/verify (both ADMIN-only)
  service.ts  — SystemService.verifyDnsRecords() — live dns.promises.Resolver queries
                against Cloudflare/Google/Quad9, mirroring domains/dns-service.ts's
                checkPropagation() pattern from F3.3

packages/shared/src/schemas/auth.ts
  — ChangePasswordSchema (currentPassword, newPassword, confirmNewPassword)

packages/shared/src/schemas/dnsOnboarding.ts
  — DnsRecordVerificationSchema / DnsVerificationResponseSchema
```

### Key Files

| File                                                      | Purpose                                                                                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/schemas/auth.ts`                     | `ChangePasswordSchema` — mirrors `RegisterSchema`'s password/confirm refine pattern                                                                                                                                              |
| `apps/api/src/modules/auth/service.ts`                    | `changePassword()` — verifies the current hash with `argon2.verify`, re-hashes and stores the new one                                                                                                                            |
| `apps/api/src/modules/auth/routes.ts`                     | `POST /api/auth/change-password`                                                                                                                                                                                                 |
| `apps/dashboard/src/hooks/useAuth.ts`                     | `changePassword(current, new, confirm)` added alongside `login`/`register`/`logout`                                                                                                                                              |
| `apps/dashboard/src/hooks/useDnsInfo.ts`                  | New hook, mirrors `useContainerStatus`'s `enabled` gating pattern — skips the request entirely for non-admins instead of eating a guaranteed 403. Also exposes `verify()`/`isVerifying`/`verification` for the live-check button |
| `apps/api/src/modules/system/service.ts`                  | `verifyDnsRecords()` — for a wildcard record, queries a fixed probe subdomain (`vexlyx-dns-check.<zone>`) instead of the literal `*.<zone>`, since a wildcard isn't directly resolvable                                          |
| `apps/dashboard/src/app/(panel)/settings/page.tsx`        | Route (Server Component wrapper, metadata only)                                                                                                                                                                                  |
| `apps/dashboard/src/components/settings/SettingsPage.tsx` | All interactive content                                                                                                                                                                                                          |

No Prisma migration needed — password change reuses the existing `User.password` column.

---

## Why the Current Session Stays Valid

Sessions are Redis-backed, opaque tokens (see F0.6/F5.1's auth plugin) — they don't embed or cache the password hash, so changing `User.password` doesn't retroactively invalidate a session that's already been issued. The user who just proved they know the current password keeps their own session; anyone else's session (or a future login attempt anywhere) starts failing immediately since `AuthService.login()` re-verifies against the stored hash on every call. This was a deliberate choice (see FEATURES.md discussion) over force-logging-out the current device, since the person changing the password already just authenticated with it.

---

## How to Test

1. Visit `/settings` as any role → page loads, no 404. Account card shows the right name/email/role.
2. Change password with the wrong current password → `401`, inline error + toast, nothing changes.
3. Change password correctly → success toast, form clears, current session stays logged in. Log out, try logging in with the old password → rejected. Log in with the new one → works.
4. As a non-ADMIN (USER/RESELLER) → the DNS Records card isn't rendered at all (no failed request in the network tab).
5. As ADMIN, in dev (`PANEL_DOMAIN`/`PUBLIC_IP` unset) → card shows the "no public IP detected" message, not an empty/broken table.
6. As ADMIN on a production install (once F5.9's installer output has real values) → card shows the real public IP and all DNS records, each copy button works and flips to a checkmark for 2s.
7. Click **Verify DNS** with `PANEL_DOMAIN`/`PUBLIC_IP` pointed at a real, resolvable hostname/IP (verified locally against `one.one.one.one` → `1.1.1.1`, which genuinely resolves that way) → the matching record gets a green "Live" badge; records that don't resolve get an amber/rose badge, not a crash.
8. Click **Verify DNS** in dev (no `PANEL_DOMAIN`/`PUBLIC_IP`) → `records: []`, so the button is effectively a no-op (nothing to verify) rather than erroring.

---

## How to Extend

- **Editable name/email:** add a form similar to the password one, `PATCH /api/auth/me` (doesn't exist yet), with email-uniqueness validation mirroring `AuthService.register()`'s existing-email check.
- **2FA (F5.17):** this page is the natural home for a "Two-Factor Authentication" card once that feature lands.
- **Sessions list / "log out other devices":** would need session metadata beyond what's stored today (IP, user agent, last-seen) — see the Redis session plugin from F5.1 for where that'd be added.
- **Per-resolver detail:** `DnsRecordVerification.resolvers` already carries each resolver's individual result (which one saw what); the badge currently only shows the aggregate. A tooltip or expandable row could surface "2/3 resolvers see it, 1 is still stale" for a more precise propagation picture.
