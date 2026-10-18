# Operations

Day-to-day running of a Vexlyx server: watching resource usage, backing up and restoring, the
firewall, restarting the mail/DNS/database stack, reclaiming disk space, managing who has access,
and upgrading. Most of this is ADMIN-only.

## Monitoring

**Monitoring** shows live CPU/RAM/disk gauges (pushed every 5 seconds), uptime and load average,
a historical trend chart (1h/24h/7d/30d), and a per-container resource table. A badge and toast
appear automatically if CPU passes 80%, RAM 85%, or disk 90% — the same numbers the dashboard home
page's Server Health widget summarizes. History is sampled and stored every 60 seconds, so the
trend chart survives a panel restart.

## Backups

**Backups** takes full-system snapshots — every project's source tree, every database, every mail
domain's Maildir, and every domain's DNS records — bundled into one archive per snapshot.

- **Schedule**: one cron schedule for the whole server, daily at 3am by default. Change it in the
  settings card; it takes effect immediately, no restart needed.
- **Retention**: keeps the most recent N daily snapshots plus M older ones spaced about a week
  apart (7/4 by default), deleting the rest automatically after each run.
- **Restore is per-item, not all-or-nothing**: open a snapshot and pick a single project,
  database, mail domain, or DNS zone to restore in place — there's no single "restore everything"
  button. Restoring is destructive to that one item, so it's behind a confirmation dialog.
- **Manual backups**: click **Backup Now** any time; progress streams live.

Not included in a snapshot: SSL certificates, vacation-responder settings, SFTP accounts, and
project environment variables — worth knowing before you rely on a restore to bring a project
fully back. Backups are stored on local disk only; there's no built-in off-server/S3 copy, so for
real disaster recovery you should periodically copy the backups directory somewhere else yourself.

## Firewall

**Firewall** manages the server's real UFW firewall — not a simulated view. Add or remove rules
(port, protocol, optional source IP/CIDR, allow/deny, comment), and set the default
incoming/outgoing policy. Rules created by the installer itself (SSH, HTTP/HTTPS, mail ports) show
up too, marked as system-managed and read-only.

**Vexlyx refuses any change that would lock you out** — you can't deny or delete the rule
protecting SSH or the panel's own API port, and you can't set a deny-by-default incoming policy
until at least one of those ports has an explicit allow rule. If a change is rejected, that's why.

## Service status

**Services** (ADMIN-only) shows live status for the five containers the hosting stack depends on
— Postfix, Dovecot, CoreDNS, PostgreSQL, and Redis — plus a read-only Docker daemon reachability
check. Each service can be started, stopped, or restarted (stop/restart ask for confirmation
first, since these are shared infrastructure, not one user's project), and you can pull a recent
log tail on demand without shelling into the server.

If mail or DNS stops working, this is the first place to check whether the underlying container
is actually running before digging further.

## Reclaiming disk space

Every redeploy used to leave the previous build's image on disk forever. The Monitoring page's
**Docker Disk Usage** card breaks down space used by images, containers, volumes, and build cache,
with a manual **Clean up** button (removes unused containers and images; volumes and build cache
are shown but never auto-removed). Two things can run this automatically instead of manually:

- **Scheduled cleanup** — an opt-in cron schedule, off by default.
- **Prune after redeploy** — an opt-in setting that removes a project's previous image right after
  its new one is confirmed running, so redeploying repeatedly doesn't slowly fill the disk.

Every cleanup run (manual, scheduled, or redeploy-triggered) is logged with what was removed and
how much space came back.

## Users, roles, and permissions

Three roles:

- **ADMIN** — everything, including user management, firewall, and backups.
- **RESELLER** — creates and manages their own sub-accounts (plain USER accounts), capped by a
  `maxSubAccounts` quota, and sees only themselves plus their sub-accounts on the Users page.
- **USER** — manages their own projects, domains, databases, and mailboxes, each capped by their
  own resource quotas (projects/domains/databases/mailboxes — `null` means unlimited).

An ADMIN sets quotas and roles from **Users**. A role change or quota update takes effect on that
user's very next request — no re-login required.

If a USER needs one extra capability without a full promotion to RESELLER — say, managing DNS —
grant it individually from the same edit dialog: **fine-grained permissions**
(`canManageDns`, `canManageFirewall`, `canManageBackups`, `canCreateSubAccounts`) are additive on
top of whatever the role already allows, and can be revoked the same way.

By default, a fresh install doesn't allow public self-registration — the first admin account
(from the install summary) creates every other account through **Users**.

## Audit log

**Audit Log** (ADMIN-only) records who changed what: user role/quota/permission changes, user
create/delete, firewall rule and policy changes, backup restore/delete, and create/delete for
projects, domains, databases, and mailboxes. Every entry keeps a before/after snapshot of exactly
what changed — filterable by actor, action, and date range. Automated actions (like a scheduled
backup's own retention cleanup) intentionally don't appear here, since they're not something a
person did.

## Upgrading

To upgrade Vexlyx to the latest release — or to repair a broken install — just re-run the
installer on the server:

```bash
curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
```

The installer installs the newest **tagged release** (for example `v0.2.0`), not whatever happens
to be on the development branch, and re-running it moves the install to the next release when one
is published. To pin a version, or to follow development instead, set `VEXLYX_REPO_REF`:

```bash
curl -fsSL https://vexlyx.atlantiqs.org/install.sh | sudo VEXLYX_REPO_REF=v0.2.0 bash   # exact release
curl -fsSL https://vexlyx.atlantiqs.org/install.sh | sudo VEXLYX_REPO_REF=main bash     # development
```

An install that already follows a branch keeps following it until you set `VEXLYX_REPO_REF=latest`.

Every installer step checks real state before acting, so re-running it is always safe: nothing
that already succeeded is redone, secrets are never regenerated or rotated, and only what actually
needs updating (code, container images, migrations) changes. See the
[installer reference](/reference/installer) for exactly what each step does.

## Next steps

- [Email](/guide/email) — the mail stack has its own operational tools (queue, delivery log, DKIM
  rotation) beyond what's covered here.
- [Domains, subdomains and SSL](/guide/domains-and-ssl) — SSL certificates renew automatically,
  but the domain's SSL tab is where you'd check on that.
