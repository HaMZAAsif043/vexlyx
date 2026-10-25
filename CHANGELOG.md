# Changelog

All notable changes to Vexlyx are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [0.4.1] - 2026-10-25

### Security

- Static and no-build PHP sites now only serve site content: the panel's `deploy` folder and dot files such as `.git` and `.env` answer 404, while `/.well-known/` stays reachable. Existing sites are updated on upgrade without a redeploy.
- The legacy per-project GitHub webhook returns one identical `401` for unknown projects, projects without a secret and bad signatures (no more project-ID enumeration) and ignores replayed `x-github-delivery` IDs; requests without that header get `400` (#67).
- The installer installs Node.js from the NodeSource apt repository with a fingerprint-pinned signing key (exactly one key accepted) instead of piping a remote script into root bash, and a generated admin password is shown on a real terminal only, never written to `/etc/vexlyx/install.log` or to redirected output (#72). Delete `/etc/vexlyx/install.log` on servers installed earlier.

### Fixed

- Large or slow file uploads are no longer cut off after 60 seconds, and an interrupted upload leaves no partial file behind, so a retry works (#155).
- Adding, verifying, securing or removing a domain no longer restarts the shared Traefik proxy, so other sites on the server stay online (#156).
- Custom domains on WordPress and no-build PHP projects route to the nginx container instead of PHP-FPM, ending the 502; existing route files are repaired automatically when the API starts (#150).
- PHP-FPM can create, modify and delete files in the docroot of no-build PHP projects (and in WordPress's `wp-content`), so self-installing apps such as a Duplicator migration work; files saved or uploaded in the File Manager stay modifiable by the application, existing projects are fixed on upgrade, and the panel's `deploy/` directory stays out of PHP's reach. The root of a git-connected project stays root-owned (PHP can write in its subfolders only), so pulls and auto-deploys keep working (#151).
- Mail clients such as Thunderbird can add and test an account again: the authenticated submission port (587) accepts a pipelined `EHLO`/`QUIT` probe, while port 25 stays strict (#158).
- A domain whose DNS is managed elsewhere now lists its DKIM record, together with MX, SPF and DMARC, the first time its mail authentication is checked, instead of only after "regenerate". The key is created once and never rotated by checking (#159).
- A GitHub webhook whose build cannot be queued now marks its deployment FAILED and lets GitHub's retry succeed with one active deployment, instead of leaving a deployment QUEUED forever and duplicating it on redelivery (#68).
- Deployed projects now get 512 MB of memory by default instead of 128 MB (`DEPLOY_MEMORY_LIMIT`). WordPress on Apache sat at its 128 MB limit and stopped answering requests.
- Upgrading a v0.3.x server no longer stops over untracked files (such as `.pnpm-store/`) or file-mode-only changes on the tracked OpenDKIM key files; edits to tracked files are still protected.
- Keep the dashboard's jsdom dependency compatible with the declared Node 22 minimum, and remove tracked development DKIM private keys from the checkout.
- Dashboard tests now collect React component tests in jsdom while keeping utility tests in Node, with initial login and project-list smoke coverage (#54).
- Switching to two-factor verification starts with an empty code field instead of retaining the sign-in email address, caught by the new login smoke test.

### Upgrade notes

- Re-run the installer; it applies everything below. From a v0.3.x server, upgrade to v0.4.0 mail state first as described in the 0.4.0 notes; the installer no longer stops for untracked files or mode-only changes.
- Traefik restarts once (new upload timeouts), so every site is offline for a few seconds.
- Postfix is recreated (submission-port change): mail delivery pauses for a few seconds and senders retry.
- Site nginx configuration is refreshed for existing static and PHP sites, and the docroot ownership of existing no-build PHP and WordPress projects is repaired once (a marker file keeps it from repeating). Neither needs a redeploy.
- Custom-domain route files are regenerated the first time the new API starts.
- Existing projects keep their old 128 MB limit until they are redeployed. Set `DEPLOY_MEMORY_LIMIT` in `/etc/vexlyx/vexlyx.env` to choose another value, then redeploy the project.
- Delete `/etc/vexlyx/install.log` if the server was installed before this version, since it may hold the generated admin password.

## [0.4.0] - 2026-10-21

### Added

- Scheduled tasks run project commands on a cron schedule, with manual runs, run history, server timezone support, per-user and reseller quotas, and optional failure emails. Commands run inside the project's application container with timeouts, bounded output, and overlap protection (#132).

### Fixed

- Mailbox, password, and alias changes now activate through validated Postfix and Dovecot state generations. Runtime maps and credentials persist across container recreation; failed activation returns an actionable error and rolls back to the previous state. Failed preparations remove unused generations, and development state ownership lets the host API write while keeping password files private (#100).
- Release notes exclude prerelease tags when selecting the previous release boundary (#143).

### Upgrade notes

- Back up existing mail state and migrate it **before updating the checkout**. Follow `docs/dev/email/mail-credential-remediation.md` to preserve routing maps and signing tables, then restart the mail services with the updated Compose configuration (#100).
- Apply the database migrations before starting the updated API; scheduled tasks adds task and run tables and the `maxScheduledTasks` user quota (#132).

## [0.3.0] - 2026-10-20

### Changed

- The one-line installer now installs the newest tagged release instead of the `main` branch, so a new server runs code that was tagged and tested. `VEXLYX_REPO_REF` still accepts an exact tag (`v0.3.0`) or a branch (`main`); re-running the installer moves a release install to the next release, and an install that already follows a branch keeps following it unless `VEXLYX_REPO_REF=latest` is set (#123).

### Fixed

- `/api/health` still reported version `0.0.1` after `0.2.0`; a test now fails if any package version and `VEXLYX_VERSION` disagree (#121).
- The installer no longer prints "Nixpacks install could not be verified" on working servers. Project builds run Nixpacks inside the API container, so the host copy was removed and Nixpacks is checked in the built API image instead (#124).
- Restoring a MySQL or PostgreSQL database from a backup always failed with `flush of closed file`, and a MySQL database that had been dropped could not be restored at all. The restore now streams the dump correctly and recreates a missing MySQL database first. Found while testing a fresh server.
- A normal install no longer ends with error-looking output: the mail images are built before the services start (no "pull access denied" lines, #133), the installer waits for the Let's Encrypt certificates before deciding whether to warn (#134), and the pnpm download prompt is gone (#135).
- Outgoing mail was sent without a DKIM signature as soon as a mail domain was added or a key regenerated: the panel told OpenDKIM to reload with SIGHUP, which makes it exit. It now uses SIGUSR1, which reloads the tables and keeps the signer running (#138).
- Mail from a newly added mail domain was refused with `451 Service unavailable` until the Postfix container was restarted, because the panel created the DKIM private key with permissions OpenDKIM rejects. New keys are now created `0600` and handed to the `opendkim` user before the signer reloads (#141).

### Security

- Deleting a user now ends all of their sessions. Previously the deleted user's login cookie kept working for up to 24 hours (their requests were answered with empty data).
- Known-password development mailboxes are no longer committed or mounted in production (#41). Dovecot refuses to start in production while a publicly known fixture credential is present; fresh installs create their runtime users file empty. **Upgrading an existing server needs the one-time steps in `docs/dev/email/mail-credential-remediation.md`**, because the installer leaves a checkout with local changes alone.
- Auth rate limiting behind Traefik now counts per client IP instead of one shared bucket (new `TRUST_PROXY` setting).
- Development Postgres, MySQL and Redis ports are bound to loopback only, and the MySQL healthcheck no longer exposes the root password in its command line.
- Dashboard responses now carry a Content-Security-Policy (including `frame-ancestors 'none'`), `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and, in production, HSTS.

### Tests

- Strict webmail TLS is now covered by a certificate matrix run against the real Roundcube image in CI: only a trusted certificate with the right host name succeeds, every rejected peer receives no credentials (#127).

### Documentation

- The `FEATURES.md` status table is recounted (it was out of date), the troubleshooting guide documents the forgot-password flow, the operations guide warns about upgrading servers installed before this release, and the release steps are written down in `docs/dev/ci-cd.md` and `CONTRIBUTING.md` (#130, #121).

### Upgrade notes

- **Servers installed before 0.3.0 are not upgraded by re-running the installer.** Older versions committed a mailbox file with publicly known credentials that the panel keeps rewriting, so Git refuses to update the checkout. Follow `docs/dev/email/mail-credential-remediation.md` first (it backs the file up, updates the checkout and removes the known credentials; Dovecot refuses to start in production while they are present), then re-run the installer so the new `TRUST_PROXY` setting is applied. Servers installed from 0.3.0 on are not affected.

## [0.2.0] - 2026-10-16

### Added

- File Manager permissions and archives: change file and folder permissions (octal and rwx editor, opt-in recursion), extract `.zip`, `.tar`, `.tar.gz` and `.tar.bz2` archives, and compress a selection into a `.zip`, with zip-slip, link, size and compression-ratio protections. Limits are configurable through `FILE_ARCHIVE_MAX_BYTES`, `FILE_ARCHIVE_MAX_ENTRIES` and `FILE_ARCHIVE_MAX_RATIO` (F5.24).

### Fixed

- Every system script command and spawned manager is now time-limited, so a hung Docker, nixpacks or git call can no longer leave orphaned processes (#52).

### Security

- `ENCRYPTION_KEY` is now required in production and must differ from `SESSION_SECRET`, so a leaked session secret can no longer decrypt stored credentials (#69).

### Documentation

- Specifications for Redis instances (F5.30), MongoDB databases (F5.31) and opt-in anonymous usage statistics (F5.32).

### Upgrade notes

- **Breaking for production installs that never set `ENCRYPTION_KEY`:** the API will not start until you set it. To keep existing data readable, set `ENCRYPTION_KEY_LEGACY_FALLBACK=true` temporarily, run `pnpm db:reencrypt`, then remove the flag. Installer-generated installs already have a key. See `docs/dev/environment-variables.md`.

## [0.1.0] - 2026-10-14

### Added

- GitHub App integration with repository and branch selection, short-lived installation tokens, and automatic deployment webhooks.
- One-command local development bootstrap with prerequisite checks, generated secrets, infrastructure startup, migrations, and seed data.
- VitePress documentation site with installation, operations, troubleshooting, developer, and generated API references.

### Changed

- Runtime container health checks now avoid unavailable application dependencies.
- GitHub App setup uses a streamlined self-hosted manifest flow.
- Documentation is organized by user intent and publishes project changelog entries automatically.

### Fixed

- GitHub App manifest OAuth configuration.
- Production domain assignment and routing behavior.
- System transactional email sender configuration.

Release automation updates this file from Conventional Commits through git-cliff. See [`docs/dev/ci-cd.md`](docs/dev/ci-cd.md).
