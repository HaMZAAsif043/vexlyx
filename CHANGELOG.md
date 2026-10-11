# Changelog

All notable changes to Vexlyx are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
