# F6.2 — CI/CD Pipeline

## What it does

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: `lint`, `typecheck`, `test` and `build` as four separate jobs, so a failure points straight at the cause.
- **Release** (`.github/workflows/release.yml`) runs when a tag matching `v*` is pushed: it re-runs CI, creates a GitHub release with generated notes, and builds and pushes the Docker images to GHCR.
- **Changelog** is generated from Conventional Commits by [git-cliff](https://git-cliff.org), configured in `cliff.toml`.

## How it works

Each CI job installs with `pnpm install --frozen-lockfile` (Node 22, pnpm version from `packageManager`), then runs the matching root script (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`), which Turborepo maps to the workspaces. Typecheck, test and build run `prisma generate` first with a placeholder `DATABASE_URL` (generation never connects), the same trick as `system/scripts/install/steps/09-build.sh`. `@vexlyx/shared` is built by Turborepo's `^build` dependency. The API tests are mocked unit tests and need no Postgres or Redis. The test job also runs two mocked Python suites: `python3 -m unittest discover -s tests -p test_restore_stop_safety.py` (restore stop safety, Docker mocked) and `python3 -m unittest discover -s tests -p test_git_url_policy.py` (isolated Git URL policy). Python integration suites that need live Docker services remain manual.

Release images, published to `ghcr.io/atlantiqshq/`:

| Image | Dockerfile | Notes |
| --- | --- | --- |
| `vexlyx-dashboard` | `apps/dashboard/Dockerfile` | Self-contained Next.js standalone image. `NEXT_PUBLIC_*` values are baked in at build time, so the published image uses the defaults. |
| `vexlyx-api` | `apps/api/Dockerfile` | Runtime toolchain only (Node, Python, Docker CLI, Nixpacks). By design it ships no app code; the installer bind-mounts the host build. |

Tags: `X.Y.Z`, plus `X.Y` and `latest` for stable tags. A tag containing `-` (for example `v1.0.0-rc.1`) is a prerelease: it gets a prerelease GitHub release and no `latest` tag.

## Cutting a release

A release is a version number, a tag and a published release that all say the same thing, so do it in this order:

1. **Prepare the version in a pull request** (`chore(release): prepare vX.Y.Z`). Change every one of these to the new version: `package.json`, `apps/api/package.json`, `apps/dashboard/package.json`, `packages/shared/package.json` and `VEXLYX_VERSION` in `packages/shared/src/index.ts`. `apps/api/src/version.test.ts` fails CI if any of them disagree. Update `CHANGELOG.md` with `git cliff --tag vX.Y.Z -o CHANGELOG.md`.
2. **Merge it, then tag that exact merge commit** (never an earlier one), starting with a prerelease such as `vX.Y.Z-rc.1`:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z-rc.1
   git push origin vX.Y.Z-rc.1
   ```

3. **Test the release candidate** on a fresh server, then tag `vX.Y.Z` the same way. A tag with a `-` creates a prerelease and no `latest` image tag.
4. **Never move or delete a published tag.** If something is wrong, fix it on `main` and release the next patch version.

Version numbers follow [Semantic Versioning](https://semver.org): `PATCH` for fixes, `MINOR` for new features that break nothing, `MAJOR` for breaking changes. While the major version is `0`, minor releases may still change behaviour.

Keep commit messages in `type(scope): summary` form so they land in the right changelog section. To refresh the committed `CHANGELOG.md`, run `git cliff -o CHANGELOG.md` locally after tagging and commit it.

## Branch protection

`main` is protected by the **Protect main** repository ruleset (Settings → Rules → Rulesets), with no bypass actors, so it applies to admins as well:

- pull request required, with 1 approving review from a code owner ([`.github/CODEOWNERS`](https://github.com/atlantiqshq/vexlyx/blob/main/.github/CODEOWNERS));
- stale approvals are dismissed on new commits, the last pusher cannot approve, and review conversations must be resolved;
- required status checks: `lint`, `typecheck`, `test`, `build`;
- no deletion and no force-push of `main`.

Because the author of a pull request cannot approve it, a code owner's own pull request needs another code owner. Add a second owner to `.github/CODEOWNERS` when the team grows. In an emergency an admin can set the ruleset to "Disabled" temporarily and must re-enable it afterwards.

## How to test

Open a pull request and check that all four jobs pass. To test a release, push a prerelease tag such as `v0.0.1-rc.1`, confirm the release and both images appear, then delete the tag, release and package versions.

## How to extend

- Dashboard tests use Vitest (`apps/dashboard/vitest.config.ts`, `src/**/*.test.ts`).
- Staging auto-deploy on merge is not implemented; add a job to `release.yml` or a new workflow when a staging server exists.
