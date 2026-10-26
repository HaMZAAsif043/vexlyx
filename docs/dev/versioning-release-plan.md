# Versioning and release plan

**Status: Implementation in progress.** Reviewed against the repository on October 26, 2026. Sections 2 and 7 mark the parts that have already shipped; anything not marked as shipped remains planned work and is not available today. See [CI/CD](ci-cd.md) and the [installer reference](installer.md) for current behavior.

## 1. Purpose and scope

Give every Vexlyx installation an identifiable version, make releases reproducible, and provide a tested way to upgrade or recover. A version must answer three practical questions:

- What application code is running on this server?
- What changes and compatibility requirements come with the next release?
- How can the operator upgrade and recover if the upgrade fails?

Use **one product version** for the API, dashboard, shared package, system scripts, and installation configuration shipped together. Keep their releases coordinated because they depend on each other. Vexlyx versions do not replace the independent versions of hosted applications, PostgreSQL, Redis, Traefik, or other third-party services.

The first delivery covers version consistency, release preparation, publication, exact-version installation, upgrade checks, and recovery documentation. Dashboard update notifications, automatic updates, independent package releases, and a hosted update service can follow later.

## 2. Current state and gaps

| Area                  | Current implementation                                                                                                                                                                                                                                                                            | Required change                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Product version       | Root, API, dashboard, and shared package manifests are synchronized at `0.4.0` by the release PR; `apps/api/src/version.test.ts` fails CI when any of them disagrees with `VEXLYX_VERSION`.                                                                                                       | The synchronization is still manual. Add a release preparation script and generate the shared value.                                  |
| Runtime reporting     | `VEXLYX_VERSION` (kept in step by the release PR and the version test) is used by the API health route and startup log. OpenAPI still hardcodes its own value (`0.0.1`).                                                                                                                          | Generate the shared value and reuse it everywhere. Include build identity.                                                            |
| Documentation package | The standalone docs package uses `0.1.0`.                                                                                                                                                                                                                                                         | Keep its tooling version separate; show product release information through the changelog and release docs.                           |
| Release trigger       | Pushing a `v*` tag reruns CI and starts GitHub release and Docker publication jobs.                                                                                                                                                                                                               | Validate the tag and version, then publish the release only after all required artifacts succeed.                                     |
| Release notes         | git-cliff generates GitHub release notes. Refreshing the committed `CHANGELOG.md` is a manual release-PR step, now documented in [ci-cd.md](ci-cd.md).                                                                                                                                            | Prepare the changelog in the release PR from the intended release range.                                                              |
| Installation          | The installer defaults to the newest stable release tag (prereleases are never chosen), accepts an exact tag through `VEXLYX_REPO_REF`, and moves an existing checkout with a detached tag checkout; dirty checkouts are left untouched, and an install that follows a branch keeps following it. | Record installation state, verify that a release is complete before offering it, and implement the dedicated upgrade procedure below. |
| Production images     | Compose builds local images tagged `latest`. The API image provides tools; application code is built on the host and mounted into it.                                                                                                                                                             | Record source commit, application build, image digests, and migration state together.                                                 |
| Release verification  | CI runs lint, typecheck, JavaScript tests, builds, and several mocked Python system suites — restore stop safety, Git URL policy, installer release channel, installer Nixpacks, mail state, and mail credential security; the [CI/CD guide](ci-cd.md) describes them.                            | Add release-specific fresh-install, upgrade, and recovery verification on a disposable server.                                        |

Relevant implementation sources:

- [Root manifest](../../package.json), [API manifest](../../apps/api/package.json), [dashboard manifest](../../apps/dashboard/package.json), and [shared manifest](../../packages/shared/package.json).
- [Shared version constant](../../packages/shared/src/index.ts), [health endpoint](../../apps/api/src/modules/health/routes.ts), and [OpenAPI configuration](../../apps/api/src/plugins/openapi.ts).
- [Release workflow](../../.github/workflows/release.yml), [CI workflow](../../.github/workflows/ci.yml), and [git-cliff configuration](../../cliff.toml).
- [Installer entrypoint](../../install.sh), [installer release-channel tests](../../tests/test_installer_release_channel.py), [production Compose configuration](../../docker-compose.prod.yml), and [installer steps](../../system/scripts/install/steps).

## 3. Version policy

### Number format

Follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html): `MAJOR.MINOR.PATCH`, with optional prerelease identifiers. Package values omit the `v`; Git tags include it. For example, package version `0.1.0-beta.1` corresponds to tag `v0.1.0-beta.1`.

| Release                         | Example               | Meaning                                                                                                    |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Beta                            | `0.1.0-beta.1`        | Available for testing; behavior may change before the final release.                                       |
| Release candidate               | `0.1.0-rc.1`          | Intended final behavior; remaining work is release verification and fixes.                                 |
| Final early-development release | `0.1.0`               | Numbered release without a prerelease suffix; compatibility still follows the pre-1.0 policy.              |
| Patch                           | `0.1.1`               | Compatible fixes and maintenance.                                                                          |
| Minor                           | `0.2.0`               | Features or explicitly documented breaking changes before 1.0.                                             |
| Major                           | `1.0.0`, then `2.0.0` | `1.0.0` establishes the stable compatibility contract; later breaking changes increment the major version. |

Before `1.0.0`, Vexlyx will apply a stricter project policy than SemVer requires: patches must remain compatible, and breaking changes require a minor bump with migration instructions. After `1.0.0`, compatible features increment the minor version and incompatible changes increment the major version.

Documentation-only changes do not require a product release unless they correct release artifacts or installation material that must be distributed again. Dependency and infrastructure changes use the bump required by their user-visible compatibility impact.

Never move a published version tag or overwrite its artifacts. A corrected release gets a new version. A release candidate and its final release also have separate immutable tags.

### Compatibility contract

Document the supported behavior of the API, shared schemas, installer settings, production configuration, persistent data, and system scripts. Examples of breaking changes include removing an API field, renaming a required environment variable without a transition, or dropping support for an installed infrastructure version.

A database migration is not automatically a breaking change. Its effect on supported application versions and upgrade paths determines the classification. Every migration still needs an upgrade and recovery assessment.

Product versioning does not automatically add `/api/v1` routes. API URL versioning should be a separate decision when external consumers require parallel API contracts.

### Release channels

- **Stable:** selects the latest published release without a prerelease suffix. A `0.x` stable-channel release is still early-development software.
- **Preview:** explicitly selects a beta or release candidate. Production installations never enter this channel automatically.
- **Development:** uses a branch or local checkout and is identified as a development build. It must not report itself as an official release.

Installations retain their exact installed version until an operator requests an upgrade. Selecting a channel resolves a version once; it does not enable unattended updates.

## 4. Single source of truth and build identity

Use the root `package.json` version as the authoritative product version. Add a release preparation script that synchronizes the API, dashboard, and shared manifests and generates the shared version export. Keep generated source available in the checkout so a normal build does not require Git history or network access.

Add a read-only CI check that fails when these values differ. For tagged builds, also require the tag to equal `v` plus the authoritative version. OpenAPI, health reporting, startup logs, and the dashboard must consume this shared value rather than define their own.

Attach a full Git commit SHA and build timestamp to release builds. Show a short commit in diagnostics when useful, while keeping the version itself a valid SemVer value. Development builds must be visibly marked as development; a modified checkout must not claim official release identity.

The dashboard should display its build version and the API-reported version. A mismatch should be visible to administrators so a stale dashboard or partial upgrade can be identified.

Record installation state outside the Git checkout, for example in a proposed `/var/lib/vexlyx/release.json`. Include:

| Field                             | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| Product version and channel       | Identify the installed release and selection policy.                     |
| Source commit                     | Identify the exact application and installer sources.                    |
| Artifact and image digests        | Identify the published artifacts and locally built images actually used. |
| Migration state                   | Record the applied migration IDs or their verified equivalent.           |
| Install time and previous release | Support diagnostics and recovery.                                        |

Update the successful-install record only after verification passes. Track an in-progress or failed upgrade separately. Keep secrets out of both records.

## 5. Release preparation and publication

### Prepare a release PR

Keep git-cliff and use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) to organize changes. Examples include `fix(mail): correct sender validation`, `feat(backups): add retention settings`, and `feat(api)!: remove deprecated response field`. A `BREAKING CHANGE:` footer can explain the migration impact.

Commit type helps prepare notes; the maintainer reviews the actual compatibility impact before choosing a version. The release PR contains:

1. The version bump and synchronized files.
2. The dated changelog section for that target version, generated from the intended release range and reviewed for accuracy.
3. User-facing changes, known limitations, and breaking changes.
4. Supported upgrade source versions, prerequisites, expected interruption, and recovery steps.
5. Results of applicable installation and upgrade checks.

For the first release, generate notes from the intended initial history. For subsequent releases, use the previous applicable release as the baseline. Final notes should cover the full release since the previous final version, including work introduced in prereleases. Avoid duplicate entries from release preparation commits.

Retain an `Unreleased` section for future changes. Merge through the repository's normal review and CI requirements.

### Publish from a reviewed commit

Use this sequence:

```text
Release PR -> review and CI -> merge -> immutable version tag
  -> validate tagged commit -> build and push artifacts
  -> verify artifacts and release manifest -> publish GitHub release
```

The tag must identify the reviewed release commit. Tag validation must reject malformed versions, tag/package mismatches, and attempts to replace an existing release.

Run required CI checks against that exact commit. Build every required artifact and capture its digest before publishing the GitHub release. Keep any release draft undiscoverable by the installer until publication succeeds.

Stable aliases such as `latest` and minor-version image tags are convenience pointers. Promote them only after all artifacts and release verification succeed, serialize publication to prevent competing releases from racing, and never use mutable aliases as the installation identity. Exact-version tags remain immutable. Prereleases must not update stable aliases.

If publication fails, leave the release unpublished and keep stable selection on the previous complete release. Reruns should verify and reuse already published artifacts for the same commit, avoiding replacement of existing versioned content.

### Release manifest

Publish a machine-readable manifest alongside the release notes. It ties the application version and source commit to required artifacts, digests, supported host prerequisites, upgrade source versions, and recovery restrictions. Release discovery must verify that a release is complete before offering it for installation.

Initially preserve the existing host-build architecture. The API runtime image and host-built API code must be tracked separately. Build from the selected commit with the frozen lockfile, record the resulting local image IDs, and preserve the previous build for recovery. A future move to images containing all application code is a separate architecture change.

## 6. Installation and upgrade behavior

### Fresh installation

The default installer should resolve the latest complete stable-channel release, display the selected version, then install that exact version. Allow explicit selection of a published stable or preview version.

Resolve release tags to commits and use a detached checkout for tagged installations; do not apply branch-style `git pull` logic to tags. Fetch the required history when upgrading an existing shallow clone. A local development checkout remains a separate, explicit mode.

Validate the canonical repository and release endpoints before implementation: the current installer default uses `atlantiqs-org/vexlyx`, while the README and docs use `atlantiqshq/vexlyx`. Release discovery, source fetching, artifact references, and documentation must agree.

If the selected release cannot be fetched or verified, stop with an actionable error. Do not silently fall back to `main`. If the checkout has local changes, report them and stop the version transition until the operator resolves them.

### Upgrade procedure

Provide a dedicated upgrade entrypoint that reuses appropriate installer steps. Its exact command syntax will be defined during implementation; this document does not introduce an executable upgrade command.

1. Read the current installed version and select an exact target release.
2. Check the release manifest, supported upgrade path, disk space, host prerequisites, local changes, and current service health. Reject unsupported downgrades or skipped migrations before making changes.
3. Fetch and stage the target sources and artifacts while the current installation still runs.
4. Acquire an upgrade lock. Enter a maintenance state that blocks panel writes, deployment jobs, and background workers that could conflict with migrations. Explain any expected hosted-service interruption.
5. Back up the panel database, protected configuration, and persistent state affected by this upgrade. Record the backup and confirm it can be read. Preserve previous code, build outputs, Compose files, and image identities.
6. Apply reviewed production migrations using `prisma migrate deploy`; switch the required services to the target build.
7. Verify the expected version, database readiness, dashboard access, login, and affected system integrations. A successful basic health response alone is insufficient.
8. Resume writes and workers, record the successful version, and show the operator the result and recovery references.

Log the source version, target version, step results, and backup location without exposing secrets. A repeated invocation must detect whether the earlier run completed or failed and follow a documented recovery or resume path.

### Recovery and database migrations

Prefer additive schema changes so the previous application can remain compatible during a transition. For a removal or rename, first add the replacement, migrate data, update consumers, and remove the old form in a later compatible release boundary.

| Failure point                                                   | Required recovery behavior                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before migration or service switch                              | Leave the existing release running, or restore its normal operating state if maintenance has begun.                                               |
| After switch with a schema compatible with the previous version | Restore the preserved application build and matching configuration, then verify services.                                                         |
| After an incompatible or partially applied migration            | Keep conflicting writes stopped and follow the release-specific repair or database-restore procedure. Do not blindly rerun or reverse migrations. |

Restoring a database backup may discard writes made after that backup. The recovery procedure must state this consequence and coordinate database, configuration, and application restoration. A backup is useful only when the restore process has been rehearsed.

## 7. Implementation work and acceptance criteria

Deliver the work in this order. Each stage should be a focused PR or small group of related PRs. The **Status** column reflects the repository on October 26, 2026, so contributors build on what exists instead of redoing it.

| Stage                     | Status on October 26, 2026                                                                                                                                                                                                                                                            | Deliverables                                                                                                                                         | Acceptance criteria                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Version consistency    | Partly shipped: the release PR keeps every manifest and `VEXLYX_VERSION` in step and `version.test.ts` fails CI on a mismatch. A sync script, a generated shared value, OpenAPI reuse (`0.0.1` is still hardcoded), the dashboard version display, and a tag↔version CI check remain. | Synchronization script; generated shared version; OpenAPI and runtime reuse; dashboard version display; CI version validation.                       | Changing the root version updates all product values. CI rejects a mismatch and an incorrect tag. The docs package remains independent.                  |
| 2. Release preparation    | Partly shipped: the manual release-PR process (version bump, changelog section, review) is documented in [ci-cd.md](ci-cd.md) and has been followed through `v0.4.0`. Dedicated tooling and templates remain.                                                                         | Release PR tooling; git-cliff release-range handling; changelog and upgrade-note template.                                                           | A beta release PR can be prepared without manual edits to multiple version values, and its notes include the intended changes once.                      |
| 3. Publication            | Partly shipped: a `v*` tag re-runs CI, then publishes the GitHub release and the GHCR images; prereleases get no stable aliases. Tag↔version validation, ordered artifact publication, the release manifest, and failure-safe reruns remain.                                          | Validated tags; ordered artifact publication; release manifest; stable/preview rules; failure-safe reruns.                                           | A failed required build cannot produce a discoverable complete release or promote stable aliases. A prerelease cannot become the stable default.         |
| 4. Exact-version installs | Partly shipped: the installer installs and upgrades by exact stable tag with detached checkouts. The installation state record and complete-release discovery remain.                                                                                                                 | Canonical repository resolution; exact-tag fetch/checkout; release discovery; installation state record.                                             | A fresh server installs the requested commit. Reinstalling the same version preserves secrets and data. Fetch failures and dirty checkouts stop clearly. |
| 5. Upgrades and recovery  | Mostly remaining: the installer can move an existing checkout to a new tag, but the dedicated upgrade entrypoint, lock, maintenance handling, backups, supported-path checks, migration execution, health verification, and recovery documentation do not exist yet.                  | Upgrade entrypoint; lock and maintenance handling; backups; supported-path checks; migration execution; health verification; recovery documentation. | A supported upgrade succeeds with data preserved. Failure and recovery are rehearsed; an unsupported path is rejected before mutation.                   |
| 6. First release          | Partly shipped: releases through `v0.4.0` are tagged and published (for example `v0.3.0-rc.1`–`rc.4` before `v0.3.0`). The disposable-server rehearsal of the §8 checklist and of upgrade/recovery paths remains.                                                                     | Disposable-server rehearsal; reviewed notes and limitations; beta, candidate, and final release verification.                                        | The release checklist below passes, and the installer selects only the intended channel.                                                                 |

Releases `v0.1.0` through `v0.4.0` have already been tagged and published following [ci-cd.md](ci-cd.md); the beta/candidate ladder above is the process future releases follow when a prerelease is warranted, not a description of what is still owed for those versions. The first *upgrade* path still has to be captured from an exact installed version or commit when the upgrade procedure is rehearsed — do not invent a past release tag for it.

## 8. Release verification checklist

Run focused automated tests for version checks, channel selection, tag resolution, publication failure handling, and upgrade state transitions. Keep the existing lint, typecheck, unit-test, and build gates. Add a disposable Ubuntu 24.04 rehearsal for behavior those checks cannot prove.

- [ ] Package versions, runtime version, Git tag, and release manifest agree.
- [ ] Required artifacts exist and their digests match the manifest.
- [ ] A preview release leaves stable selection and stable image aliases unchanged.
- [ ] A fresh install reaches the dashboard and allows administrator login.
- [ ] Reinstalling the same version preserves secrets, configuration, and existing data.
- [ ] An upgrade from every declared supported baseline preserves panel data and existing projects.
- [ ] A representative app deployment, domain route, and mail/DNS workflow work where configured; any excluded area is documented as a limitation.
- [ ] Invalid targets, unavailable artifacts, insufficient space, local changes, and concurrent upgrade attempts fail clearly before unsafe mutation.
- [ ] A migration or post-upgrade verification failure leaves an actionable state and a tested recovery path.
- [ ] Backup restoration and previous-application restoration are rehearsed on the disposable server.
- [ ] Changelog, prerequisites, interruption expectations, supported upgrade paths, and known issues are reviewed.

For `1.0.0`, additionally require a documented compatibility contract, tested backup restoration, dependable installation and upgrades, and no unresolved release-blocking issues in the supported core workflows. The number of features alone does not determine readiness.

## 9. Documentation updates during implementation

Keep this page as the implementation plan until its tasks are complete. As behavior ships, update the [CI/CD reference](ci-cd.md), [installer reference](installer.md), [operations guide](../guide/operations.md), [contributing guide](../../CONTRIBUTING.md), and [changelog](../../CHANGELOG.md) with the actual commands and guarantees.

The documentation site can continue to track `main` initially, provided unreleased behavior is clearly labeled. Each release must still link to documentation or source instructions for its exact tag so operators can recover older installations. A full version selector for the docs site can be added when multiple maintained release lines justify it.
