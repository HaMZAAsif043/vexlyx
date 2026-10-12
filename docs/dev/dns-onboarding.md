# Onboarding: DNS Records & Public IP Visibility (F5.9)

> **Status:** 🟢 COMPLETED
> **Feature:** The installer detects the server's public IP and prints every DNS record the admin needs to create; the same info is exposed via `GET /api/system/dns-info` and shown on the dashboard's `/settings` page (F5.11).

---

## What It Does

- The installer auto-detects the server's public IPv4 address (external IP-echo services, falling back to the local route's source address) and persists it to `/etc/vexlyx/vexlyx.env` as `VEXLYX_PUBLIC_IP`, re-detecting on every run since it can legitimately change (e.g. after migrating hosts).
- The final install-summary step prints every DNS record the admin needs: panel, API, webmail and
  project-wildcard A records, plus `A <mail-hostname> -> <ip>` and
  `MX <mail-domain> -> <mail-hostname>` (priority 10) for inbound hosted mail.
- A new `VEXLYX_BASE_DOMAIN` install variable (defaults to `VEXLYX_DOMAIN`) lets the panel domain and the deployed-project base domain live in separate DNS zones — the wildcard record follows whichever is configured.
- `GET /api/system/dns-info` (ADMIN-only) returns the same `{ publicIp, domain, baseDomain, records }` shape, surfaced on `/settings` with a live "Verify DNS" propagation check (F5.11).

**Found during live-server testing:** the `api.<domain>` record was missing from the original list. The dashboard's browser JS calls `https://api.<domain>` directly (`NEXT_PUBLIC_API_URL` in `docker-compose.prod.yml`), and that only "worked" without its own record by accident — when `VEXLYX_BASE_DOMAIN` equals `VEXLYX_DOMAIN` (the default), the wildcard record incidentally covers `api.<domain>` too. With a split base domain, the wildcard lives in a different zone and doesn't cover it at all, so the API would be unreachable. It's now always listed explicitly.

---

## Architecture

```
Installer (system/scripts/install/)
  config.sh          — prompts VEXLYX_BASE_DOMAIN (defaults to VEXLYX_DOMAIN)
  lib.sh             — detect_public_ip(), upsert_secret()
  steps/08-network.sh — detects IP every run, upserts VEXLYX_PUBLIC_IP into vexlyx.env
  steps/16-summary.sh — prints IP + required DNS records

docker-compose.prod.yml (api service)
  PANEL_DOMAIN=${VEXLYX_DOMAIN}
  PUBLIC_IP=${VEXLYX_PUBLIC_IP:-}
  BASE_DOMAIN=${VEXLYX_BASE_DOMAIN}
  HOSTED_MAIL_HOSTNAME=${VEXLYX_MAIL_HOSTNAME}
  HOSTED_MAIL_DOMAIN=${VEXLYX_MAIL_DOMAIN}
       │
       ▼
apps/api/src/modules/system/{service,routes}.ts
  GET /api/system/dns-info  →  DnsOnboardingInfoResponse
```

### Key Files

| File                                            | Purpose                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `system/scripts/install/lib.sh`                 | `detect_public_ip()` (external services + local route fallback), `upsert_secret()` (update-in-place for values that change across re-runs) |
| `system/scripts/install/config.sh`              | Prompts + persists `VEXLYX_BASE_DOMAIN`                                                                                                    |
| `system/scripts/install/steps/08-network.sh`    | Detects and persists `VEXLYX_PUBLIC_IP` on every run                                                                                       |
| `system/scripts/install/steps/16-summary.sh`    | Prints the IP + DNS records at the end of install                                                                                          |
| `docker-compose.prod.yml`                       | Wires `PANEL_DOMAIN` / `PUBLIC_IP` / `BASE_DOMAIN` into the `api` container                                                                |
| `apps/api/src/config/env.ts`                    | Panel, public-IP and hosted-mail onboarding configuration                                                                                  |
| `apps/api/src/modules/system/service.ts`        | Builds and verifies A/MX records; returns an empty list rather than guessing if domain/IP are unknown                                      |
| `apps/api/src/modules/mail/required-records.ts` | Shared source of truth for the inbound mail A/MX pair                                                                                      |
| `apps/api/src/modules/system/routes.ts`         | `GET /api/system/dns-info`                                                                                                                 |
| `packages/shared/src/schemas/dnsOnboarding.ts`  | `DnsOnboardingInfoSchema` / `DnsRecordSuggestionSchema`, shared between API and dashboard                                                  |

See `docs/dev/settings-page.md` for how `/settings` consumes this endpoint (F5.11).

---

## Why Re-Detect the IP Every Run

`generate_secrets()` in `config.sh` is deliberately write-once — it never touches `SESSION_SECRET`, `ENCRYPTION_KEY`, or the DB passwords again once they exist, since rotating them out from under a running install would invalidate every session and encrypted env var. A public IP has no such constraint and _can_ legitimately change (server migration, cloud provider reassigning addresses), so `upsert_secret()` gives it different semantics: update the persisted value in place on every run instead of leaving a stale one behind.

## Why Local-Route Fallback

Most cloud VPS network stacks expose a public IP directly on the primary interface, so an external echo service (`api.ipify.org`, `icanhazip.com`, `ifconfig.me`) is reliable in the common case. But an offline/air-gapped install has no outbound HTTP at all — `ip route get 1.1.1.1`'s source address is a reasonable best-effort guess in that case (it won't be correct behind NAT/a load balancer, but it's strictly better than nothing, and the admin can always override `VEXLYX_PUBLIC_IP` by hand in `/etc/vexlyx/vexlyx.env`).

---

## How to Test

1. Run the installer against a fresh server → the final summary lists the detected public IP,
   four application A records, the mail-host A record and the priority-10 mail-domain MX record.
2. Block outbound HTTP on a test VM before installing → IP detection falls back to the local route address (or prints a warning if that fails too), install still completes.
3. Set `VEXLYX_BASE_DOMAIN` to a different domain than `VEXLYX_DOMAIN` → the wildcard record in the summary uses the base domain; the panel, api, and webmail records use the panel domain regardless.
4. `curl` (as an authenticated ADMIN) `GET /api/system/dns-info` on a production install → same IP/records as the installer printed. As a non-ADMIN user → `403`.
5. In local dev (`PANEL_DOMAIN`/`PUBLIC_IP` unset) → the endpoint returns `records: []` rather than guessing.
6. Set custom `VEXLYX_MAIL_HOSTNAME` and `VEXLYX_MAIL_DOMAIN` values → the installer and Settings
   show those exact values, and Verify DNS checks A and MX using the appropriate resolver methods.
7. Deployed and verified live against a real server (`panel.mindgera.site`, fresh install + `git clone` deploy) — confirmed the installer detects the correct public IP and prints the application records.

---

## How to Extend

- **IPv6:** `detect_public_ip()` and the record list are IPv4 (`A`) only today; an `AAAA` equivalent would need a second detection pass (`https://api64.ipify.org` etc.) and a second record type in `DnsRecordSuggestionSchema`.
- **Reserved-slug collision:** since `api`/`webmail` (and any future reserved prefix) live under the same wildcard-covered zone as deployed projects, a project deployed with the slug `api` or `webmail` would collide with the panel's own subdomain. Worth a slug-reservation check in project creation (`projects/service.ts`) — out of scope here since it's a project-creation validation concern, not a DNS-onboarding one.
