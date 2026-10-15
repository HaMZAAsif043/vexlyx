# Changelog

All notable changes to Vexlyx are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- GitHub App integration with repository and branch selection, short-lived installation tokens, and automatic deployment webhooks.
- One-command local development bootstrap with prerequisite checks, generated secrets, infrastructure startup, migrations, and seed data.
- VitePress documentation site with installation, operations, troubleshooting, developer, and generated API references.
- File Manager permissions and archives: change file and folder permissions (octal and rwx editor, opt-in recursion), extract `.zip`, `.tar`, `.tar.gz` and `.tar.bz2` archives, and compress a selection into a `.zip`, with zip-slip, link, size and compression-ratio protections. Limits are configurable through `FILE_ARCHIVE_MAX_BYTES`, `FILE_ARCHIVE_MAX_ENTRIES` and `FILE_ARCHIVE_MAX_RATIO` (F5.24).

### Changed

- Runtime container health checks now avoid unavailable application dependencies.
- GitHub App setup uses a streamlined self-hosted manifest flow.
- Documentation is organized by user intent and publishes project changelog entries automatically.

### Fixed

- GitHub App manifest OAuth configuration.
- Production domain assignment and routing behavior.
- System transactional email sender configuration.

### Security

- `ENCRYPTION_KEY` is now required in production and must differ from `SESSION_SECRET`, so a leaked session secret can no longer decrypt stored credentials (#69).

### Upgrade notes

- **Breaking for production installs that never set `ENCRYPTION_KEY`:** the API will not start until you set it. To keep existing data readable, set `ENCRYPTION_KEY_LEGACY_FALLBACK=true` temporarily, run `pnpm db:reencrypt`, then remove the flag. Installer-generated installs already have a key. See `docs/dev/environment-variables.md`.

Release automation updates this file from Conventional Commits through git-cliff. See [`docs/dev/ci-cd.md`](docs/dev/ci-cd.md).
