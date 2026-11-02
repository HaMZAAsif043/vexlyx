# Troubleshooting

Common problems and where to look first. If you're chasing a domain, DNS, or mail delivery issue,
[Domains, subdomains and SSL](/guide/domains-and-ssl#troubleshooting) and
[Email](/guide/email#troubleshooting-delivery) have their own dedicated troubleshooting sections —
this page covers everything else: installs, logins, deploys, backups, and reading the right logs.

## Where to look first

Vexlyx surfaces logs in the dashboard rather than requiring SSH access for routine problems:

| Symptom | Where to look |
|---|---|
| A build is failing | Project → **Build** tab — streams live, and replays history if reopened |
| A running container is misbehaving | Project → **Runtime Logs** panel — live `docker logs --follow` |
| Mail/DNS/DB containers seem down | **Services** (ADMIN) — live status, restart, and a log tail per container |
| "Who changed this?" | **Audit Log** (ADMIN) — every role/quota/firewall/backup/resource change, with before/after values |
| Mail delivery specifically | **Mail → Queue** / **Delivery Log** (ADMIN) — see [Email troubleshooting](/guide/email#troubleshooting-delivery) |

## Installation problems

- **A step failed partway through** — just re-run the exact same install command. Every step
  checks real state before acting, so re-running is always safe and picks up where it left off; it
  never regenerates secrets or duplicates containers/rules.
- **No TLS certificate yet / browser warning right after install** — if the domain doesn't point at
  the server's IP yet, Traefik keeps retrying the Let's Encrypt request automatically once DNS
  propagates; the panel is reachable over HTTPS with a browser warning in the meantime. Double-check
  the A record.
- **A generated admin password was lost** — it's shown exactly once, on the terminal, at the end of install. It is not
  written to the install log or the secrets file, so it cannot be recovered. See [Recovering admin access](#recovering-admin-access) below.
- See the [installer reference's testing notes](/reference/installer#bugs-found-during-the-real-install-and-their-fixes)
  for a list of real issues found during end-to-end installs and how they were fixed — useful if
  something looks like it might be an environment-specific quirk rather than something you did
  wrong.

## Recovering admin access

**Regular users** can reset a forgotten password themselves: **Forgot password?** on the sign-in
page emails a single-use link that expires after 30 minutes. A reset ends all of that user's
sessions and does not sign them in, and two-factor authentication stays on. This needs the
panel's [system email](/reference/system-transactional-email) to be deliverable: **Settings →
System Email** shows the status and has a test button.

**Admin accounts are deliberately not reset by email**: an admin is effectively root on the
server, so a compromised mailbox must not be enough to take one over (set
`ALLOW_ADMIN_EMAIL_RESET=true` only if you accept that). While logged in, **Settings → Change
Password** works for everyone. If an admin is locked out entirely, create a brand-new admin
account directly on the server (this never touches or resets any existing account):

```bash
cd /opt/vexlyx
docker compose --env-file /etc/vexlyx/vexlyx.env -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm --no-deps \
  -e VEXLYX_ADMIN_EMAIL="newadmin@example.com" \
  -e VEXLYX_ADMIN_PASSWORD="a-strong-password" \
  -e VEXLYX_ADMIN_NAME="Admin" \
  api pnpm exec tsx prisma/create-admin.ts
```

Log in with the new account, then use **Users** to fix or remove the old one.

## Deploys and builds

- **Project stuck in "Creating" or shows "Error"** — open the project's **Build** tab first; the
  log almost always names the actual failure (a missing start script, a failed `npm install`, a
  Dockerfile syntax error, and so on).
- **Build succeeds but the site doesn't load** — the most common cause is the app not listening on
  the port/host Vexlyx expects. Make sure your app binds to `0.0.0.0` (not `localhost`) and reads
  its port from the `PORT` environment variable rather than hardcoding one — see the
  [per-type notes in Deploying a project](/guide/deploying#per-type-notes) for the exact port each
  project type expects.
- **Private repo won't connect** — you need an SSH deploy key added to the repository before
  connecting over SSH; see [Connect a repository](/guide/deploying#connect-a-repository).
- **Pushing to GitHub doesn't trigger a redeploy** — check that the webhook is registered with the
  exact URL and secret from the project's Git settings, that the event is `push` (not just `ping`),
  and that you're pushing to the branch the project is actually configured to deploy — pushes to
  any other branch are intentionally ignored, not treated as an error.
- **A redeploy didn't pick up a new environment variable** — most frameworks only need a redeploy,
  but a few (Next.js's `NEXT_PUBLIC_*`, Vite's `VITE_*`) bake variables into the build itself; make
  sure you redeployed *after* adding the variable, not before.

## "Action refused" errors

A few actions are refused on purpose, not because something's broken:

| Error | Why | What to do |
|---|---|---|
| `LOCKOUT_RISK` | A firewall change would have blocked SSH or the panel's own API port | Adjust the rule so SSH/the panel port keeps an explicit allow |
| `QUOTA_EXCEEDED` | You've hit your account's project/domain/database/mailbox/sub-account limit | Ask an ADMIN to raise the quota in **Users**, or free up an existing resource |
| `DNS_NOT_MANAGED` | You tried to use the DNS zone editor on a domain still in Connect mode | Either add the record at your own registrar, or switch the domain to [Hosted DNS](/guide/domains-and-ssl#hosting-dns-on-vexlyx-optional-advanced) |
| `DNS_MODE_MAIL_ACTIVE` | You tried to switch a domain back to Connect mode while it still has mailboxes | Remove the domain's mailboxes first, or keep it in Hosted DNS mode |
| `CATCH_ALL_EXISTS` | A domain can only have one catch-all alias | Edit or delete the existing catch-all instead of creating a second |

## Backups

- **"Backup script exited with code 2 and no output"** — the backup process couldn't start at all,
  almost always a misconfigured Python interpreter on the server rather than anything about your
  data. The error message (as of recent versions) includes the actual OS error — check that first.
  See the [backup system reference](/reference/backup-system#troubleshooting) for the full
  diagnosis path.
- **Restore didn't bring everything back** — backups don't include SSL certificates, vacation
  responder settings, SFTP accounts, or project environment variables. Re-provision those
  separately after a restore.

## Running low on disk

Check **Monitoring → Docker Disk Usage** — old build images from repeated redeploys are the most
common cause. Run a manual cleanup, or turn on **Prune old image after redeploy** so it happens
automatically going forward. See [Operations](/guide/operations#reclaiming-disk-space).

## Still stuck?

Open an issue on [GitHub](https://github.com/atlantiqshq/vexlyx) with what you were doing, what
you expected, what happened instead, and the relevant log excerpt from the Build tab, Runtime
Logs, or Services page.
