# In-Panel Update Notifications (F5.33)

> **Status:** 🟢 COMPLETED  
> **Feature:** Administrators are told when a newer stable release exists, with links to the release notes and the upgrade guide.

---

## What It Does

Vexlyx upgrades by re-running the installer, so a server stays on whatever release it was installed from unless someone decides to upgrade. This feature closes the "how would I know?" gap:

- `GET /api/system/update` (ADMIN) compares `VEXLYX_VERSION` with the newest **stable** GitHub release
- The dashboard shows admins a dismissible banner: release version, release notes link, upgrade-guide link
- Dismissal is remembered per version, so the next release is announced again
- The check is display-only: nothing is downloaded, built or installed

It is intentionally unrelated to opt-in telemetry (F5.32) — the outbound request carries no install id and is made only when an administrator loads the panel.

---

## Architecture

```
Dashboard (admin)                 API                         GitHub
─────────────────                 ───                         ──────
useSystemUpdate() ──GET──▶  /api/system/update
                              │
                              ├─ env.UPDATE_CHECK_ENABLED=false ──▶ { checkEnabled: false }
                              │
                              ├─ Redis GET system:update-info (6h / 1h on failure)
                              │        └─ hit ──▶ cached payload
                              │
                              └─ GET /repos/:repo/releases/latest ──▶ tag_name, html_url, published_at
                                     │
                                     └─ SystemUpdateService caches result, compares versions
```

### Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/modules/system/update-service.ts` | GitHub lookup, Redis cache, failure handling |
| `apps/api/src/modules/system/routes.ts` | `GET /api/system/update` (ADMIN only) |
| `apps/api/src/utils/version.ts` | `isNewerVersion()` — semver comparison, prerelease-aware |
| `packages/shared/src/schemas/systemUpdate.ts` | Response schema (`SystemUpdateInfo`) |
| `apps/dashboard/src/hooks/useSystemUpdate.ts` | Query, admin-gated with `useAuth()` |
| `apps/dashboard/src/components/layout/UpdateBanner.tsx` | Banner + per-version dismissal (`localStorage`) |
| `apps/dashboard/src/app/(panel)/layout.tsx` | Renders `<UpdateBanner />` under the header |

---

## Response Shape

```json
{
  "currentVersion": "0.4.3",
  "latestVersion": "0.4.4",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/atlantiqshq/vexlyx/releases/tag/v0.4.4",
  "publishedAt": "2026-11-02T10:00:00Z",
  "checkedAt": "2026-11-02T12:34:56.789Z",
  "checkEnabled": true,
  "checkFailed": false
}
```

- `latestVersion`, `releaseUrl`, `publishedAt` are `null` when the check is disabled or failed
- `checkFailed: true` means GitHub was unreachable or returned an unusable release; the UI stays silent
- The endpoint always answers `200` for an authorised admin — a GitHub outage is data, not an API error

## Caching and Failure Behaviour

| Case | TTL | Result |
|------|-----|--------|
| Successful lookup | 6 hours | Cached in Redis under `system:update-info` |
| GitHub error, timeout (5 s), non-2xx, draft/prerelease-only | 1 hour | `checkFailed: true`, warning logged, nothing thrown |
| Redis unavailable | — | Check still runs; caching is skipped with a warning |
| `UPDATE_CHECK_ENABLED=false` | — | No outbound call, no cache write, `checkEnabled: false` |

A short failure TTL means a briefly unreachable GitHub does not hide a release for six hours, while the panel still makes at most one request per hour per server.

## Version Comparison

`isNewerVersion(candidate, current)` in `apps/api/src/utils/version.ts`:

- Accepts an optional leading `v` and ignores build metadata (`+build.7`)
- Compares major/minor/patch numerically, so `0.4.10 > 0.4.9`
- A final release outranks its own prereleases (`0.4.3 > 0.4.3-rc.1`), and prereleases compare segment-wise (`rc.10 > rc.9`)
- Unparseable input never reports an update, so a malformed tag cannot produce a false banner

GitHub's `/releases/latest` excludes prereleases, so an RC never reaches the comparison in practice; the draft/prerelease guard covers the remaining cases.

## Operator Controls

| Variable | Default | Meaning |
|----------|---------|---------|
| `UPDATE_CHECK_ENABLED` | `true` | `false` skips the lookup entirely (air-gapped servers) |
| `UPDATE_CHECK_REPO` | `atlantiqshq/vexlyx` | `owner/repo` whose stable releases are compared |

Documented in `apps/api/.env.example`; production values live in `/etc/vexlyx/vexlyx.env`.

## Testing

```bash
# Unit tests — comparison + service (mocked fetch, fake Redis)
pnpm --filter @vexlyx/api test -- src/utils/version.test.ts src/modules/system/update-service.test.ts
```

Covered: newer/equal/older versions, `v` prefix, build metadata, prerelease ordering, invalid input, GitHub failure, cached hit, unreadable cache, disabled check.

Manual verification:

1. As an admin, load any panel page → no banner when running the newest release
2. Set `UPDATE_CHECK_REPO` to a repository whose latest release is newer (or temporarily set `VEXLYX_VERSION` lower) → banner appears after the cache expires; delete `system:update-info` in Redis to force it immediately
3. As a non-admin → no request to `/api/system/update` (403 if called directly)
4. Point `UPDATE_CHECK_REPO` at a nonexistent repo → banner stays hidden, one warning in the API log
