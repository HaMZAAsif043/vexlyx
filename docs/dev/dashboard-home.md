# Dashboard Home Page: Real Widgets (F5.16)

> **Status:** 🟢 COMPLETED
> **Feature:** Real stat counts, server-health widget, recent-activity feed, and quick actions on the dashboard home page.

---

## What It Does

`apps/dashboard/src/app/(panel)/dashboard/page.tsx` used to be a pure stub — four `StatCard`s hardcoded to `value="0"` and a static "Getting Started" box, with no data fetching at all. F5.16 replaces it with a real overview:

- **Stat tiles** — live counts of projects, domains, databases, and mailboxes, scoped to the signed-in user, each with a thin used/limit quota bar when the user has a configured quota for that resource (unlimited resources show no bar).
- **Server Health widget** — a compact CPU/RAM/disk snapshot as three stacked `UsageBar` rows, deliberately slimmer than the circular gauges on the full `/monitoring` page.
- **SSL expiry banner** — a dismissable-by-navigation amber banner ("N SSL certificates expiring soon or expired") shown above Quick Actions whenever the user has at least one domain certificate expiring soon or expired, linking to `/domains`.
- **Recent Activity feed** — a single merged, newest-first list of the user's own recent deployments (linking to that project's Deploy/Build tab), recent backups (ADMIN only), and any of the user's domains with an SSL certificate expiring soon or expired (linking to that domain's SSL tab).
- **Quick actions** — links to `/projects`, `/domains`, `/databases`, `/mail`. Creation itself stays modal-based on each of those pages; these are plain navigation links, not deep links that auto-open a modal.
- **Getting Started box** — now only shown when the account has zero projects, instead of unconditionally.

---

## Architecture

```
Browser (DashboardOverview — StatCard / ResourceUsageWidget / RecentActivityFeed / QuickActions)
  │  REST: GET /api/dashboard/summary   (useDashboardSummary — TanStack Query)
  ▼
apps/api/src/modules/dashboard/{routes,service}.ts
  │  getUsageSummary()        — apps/api/src/utils/quota.ts (user-scoped resource counts)
  │  MonitoringService.getServerMetrics()  — apps/api/src/modules/monitoring/service.ts
  │  Deployment / BackupSnapshot           — Prisma (project-scoped / global+ADMIN-only)
  │  SslService.checkExpiryAlerts()        — apps/api/src/modules/domains/ssl-service.ts
  ▼
Prisma / system_monitor.py
```

`DashboardService.getSummary(userId)` composes three things in parallel:

1. **Stats** — reuses `getUsageSummary()` (already used for `GET /api/users/me/usage`), which returns `{ used, limit }` per resource directly — the response's `stats.<resource>` is that object unmodified, so the frontend's quota bars come for free with no extra query.
2. **Server metrics (ADMIN only)** — for non-admins `serverMetrics` is `null` and nothing is collected, matching the admin-only `/api/monitoring/*` policy (host-wide data; see `docs/dev/monitoring.md`). For admins it calls `MonitoringService.getServerMetrics()` and catches any failure (e.g. `system_monitor.py` unavailable), returning `null` instead of failing the whole request. The frontend widget shows an "unavailable" message rather than breaking the page.
3. **Activity feed** — merges three sources, sorted by timestamp descending and capped at 15 items:
   - Recent deployments, via `prisma.deployment.findMany({ where: { project: { userId } } })` (deployments have no `userId` of their own).
   - Recent backups, only when the caller's role is `ADMIN` (looked up separately, since `BackupSnapshot` has no `userId` at all and is fully global — this mirrors the existing `requireRole("ADMIN")` boundary on `GET /api/backups`).
4. **`sslExpiringCount`** — counted from the *full* (unfiltered-by-cap) SSL alert list returned alongside the activity sources, so it stays accurate even if SSL alerts get pushed out of the merged feed's top 15 by other activity. Drives the amber banner on the frontend independently of the activity feed.
   - SSL expiry alerts, via `SslService.checkExpiryAlerts()` (which also refreshes certificate status as a side effect), scoped by the service to the caller's own domains (`checkExpiryAlerts(userId)`).

The route (`GET /api/dashboard/summary`) requires only `app.requireAuth` — the backup and server-metrics visibility checks happen inside the service (role resolved once per request), not as a route-level role gate, since everything else should still be visible to non-admins. The Server Health widget is rendered for `ADMIN` only.

---

## How to Test

Manual (`pnpm dev`):
1. Fresh/empty account → stat tiles show real `0`s, Getting Started box visible, activity feed shows its empty state, Server Health (admin accounts only) still shows live server-level metrics.
2. Populated account (projects, domains with SSL, databases, mailboxes, at least one deployment) → accurate counts, Getting Started box gone, activity feed shows deployments/SSL alerts sorted newest-first.
3. Log in as non-ADMIN with backups present elsewhere in the system → feed has no backup entries. Log in as ADMIN → backup entries appear.
4. Quick-action buttons navigate to the right list pages; no modal auto-opens.
5. Temporarily break the monitoring script → dashboard still loads, Server Health widget degrades gracefully, rest of page unaffected.

Automated: `pnpm --filter @vexlyx/api test` runs `apps/api/src/modules/dashboard/service.test.ts` (Vitest), covering stat counts, admin/non-admin backup visibility, the monitoring-failure fallback, SSL-alert scoping to the caller's own domains, and feed capping/sorting.

---

## How to Extend

To add a new activity source, add a private `recentX(): Promise<ActivityItem[]>` method to `DashboardService`, merge its result into the `Promise.all` inside `buildActivityFeed`, and it will automatically be sorted and capped alongside the existing sources. Add the corresponding case to `service.test.ts`.
