# Changelog

All notable changes to Vexlyx are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- Restoring a MySQL or PostgreSQL database from a backup always failed with `flush of closed file`, and a MySQL database that had been dropped could not be restored at all. The restore now streams the dump correctly and recreates a missing MySQL database first. Found while testing a fresh server.

## [0.3.0] - 2026-10-19

### Changed

- The one-line installer now installs the newest tagged release instead of the `main` branch, so a new server runs code that was tagged and tested. `VEXLYX_REPO_REF` still accepts an exact tag (`v0.3.0`) or a branch (`main`); re-running the installer moves a release install to the next release, and an install that already follows a branch keeps following it unless `VEXLYX_REPO_REF=latest` is set (#123).

### Fixed

- `/api/health` still reported version `0.0.1` after `0.2.0`; a test now fails if any package version and `VEXLYX_VERSION` disagree (#121).
- The installer no longer prints "Nixpacks install could not be verified" on working servers. Project builds run Nixpacks inside the API container, so the host copy was removed and Nixpacks is checked in the built API image instead (#124).

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
