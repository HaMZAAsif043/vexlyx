# F5.1 — One-Line Server Installer

Automated, idempotent installation of Vexlyx onto a fresh Ubuntu 24.04 server via:

```bash
curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
```

## What it does

1. Installs Docker Engine + Compose, Node.js 22 (from the NodeSource apt repository, with its signing key checked against a pinned fingerprint — see [Pinned NodeSource key](#pinned-nodesource-key)) + pnpm, and Python 3 + `cryptography`. Nixpacks is not installed on the host: project builds run it inside the API container, whose image ships it, and step 10 checks it there. (Node 22, not 20 — pnpm 11, pinned in `package.json`'s `packageManager` field, uses the `node:sqlite` built-in and fails with `ERR_UNKNOWN_BUILTIN_MODULE` on Node 20.)
2. Collects the panel domain, admin credentials, and mail hostname (env vars, interactive prompt, or safe generated defaults — see [Configuration](#configuration)).
3. Generates and persists application secrets exactly once.
4. Builds the panel on the host (`pnpm install && pnpm build && prisma generate`) and builds the dashboard/api Docker images.
5. Brings up Postgres/MySQL/Redis, runs Prisma migrations, creates the admin user.
6. Brings up Traefik (requesting a real Let's Encrypt certificate for the panel domain), CoreDNS, Postfix, Dovecot, Roundcube, and the panel itself.
   It also requests a certificate for `VEXLYX_MAIL_HOSTNAME`, installs that
   trusted pair into Postfix and Dovecot, and enables a 12-hour renewal sync.
7. Configures UFW.

Every step checks real state before acting (file exists? container running? rule present?), so re-running `install.sh` at any point — including after a failure — is always safe and cheap for whatever already succeeded.

## Architecture

```
install.sh                                 — public entrypoint (this is what curl fetches)
  └─ clones/updates the repo into /opt/vexlyx, then execs:
system/scripts/install/run.sh              — orchestrator
  ├─ lib.sh                                — logging, root check, secrets-file helpers
  ├─ config.sh                             — collects config, generates secrets
  └─ steps/01-preflight.sh … 16-summary.sh — one file per concern, run in order
```

`install.sh` is deliberately thin: it only figures out where the Vexlyx checkout lives and hands off. All real logic is versioned inside the repo under `system/scripts/install/`, so it can be reviewed, tested, and changed like any other code — and a `curl | bash` install always runs whatever the pinned `VEXLYX_REPO_REF` branch/tag actually contains.

### Which version is installed

`VEXLYX_REPO_REF` decides what `install.sh` puts on the server:

| Value | Result |
| --- | --- |
| unset or `latest` | The newest stable release tag, `vMAJOR.MINOR.PATCH`. Prerelease tags (`v1.0.0-rc.1`) and non-version tags are never chosen, and versions compare numerically (`v0.10.0` is newer than `v0.9.0`). |
| a tag such as `v0.2.0` | That exact release. |
| a branch such as `main` | The tip of that branch, for development. The installer says it is not a tagged release. |

Re-running the installer on an existing checkout moves it to the newest release, says "Already on release vX" when nothing is newer, and never touches a checkout with local changes. An install that follows a branch keeps following it unless `VEXLYX_REPO_REF` is set, so a re-run cannot silently change an operator's channel. If the repository has no release tag yet, the installer warns and falls back to `main`.

Why releases are the default: a public install must run code that was tagged, tested and published, not whatever was merged a minute ago. Tags are created only by maintainers (see [CI/CD](ci-cd.md)), and a published tag is never moved. The logic lives in functions in `install.sh` and is covered by `tests/test_installer_release_channel.py`.

### Why the API container is different from the dashboard container

The dashboard is a stateless frontend — `apps/dashboard/Dockerfile` is a conventional multi-stage `turbo prune` + Next.js `standalone` build, fully self-contained.

The API is not. Every deploy/build/mail/DNS/SSL/database feature works by spawning `system/python/*.py` as a child process (`spawn("python", [scriptPath])`), which in turn shells out to the **host's** `docker` CLI — `docker_manager.py` runs `docker compose up -d` for each user project, `postfix_manager.py` runs `docker exec vexlyx-postfix ...`, `ssl_manager.py` reads/writes `docker/traefik/certs`, etc. (This is deliberate — see CLAUDE.md §6: routes must never call Docker directly, only through the Python layer.)

Containerizing the API without accounting for that coupling would silently break nearly every feature. Instead, `apps/api/Dockerfile` builds a **toolchain-only** image (Node, Python, git, Nixpacks, and a Docker CLI client) with no application code baked in. At runtime, `docker-compose.prod.yml` bind-mounts:

- the entire `/opt/vexlyx` checkout (already built on the host by step 09) at the _same absolute path_ inside the container, and
- `/var/run/docker.sock`

This "Docker-outside-of-Docker" setup means every relative path the Python managers resolve (`Path.cwd().parent.parent / "docker" / "traefik" / "certs"`, `script_dir.parent / "templates" / "docker-compose"`, etc.) and every path in a `docker-compose.yml` the API generates for a user project, resolves identically whether read from inside the API container or by the host daemon it's talking to. It also means the API container's Python subprocess model is unchanged from how it already works today — Docker access is still mediated entirely through `system/python/*.py`, just running one layer further down.

### Compose overlay

Production only ever changes `docker-compose.yml` (the dev environment, untouched) via an overlay:

```bash
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` uses the Compose Spec's `!override` tag to fully replace (not append to) a base service's `ports`/`volumes` list — e.g. Traefik's dev-only `insecure` dashboard port and Postgres/MySQL/Redis's host-published ports are removed in prod, and CoreDNS is bound to `127.0.0.1` only (it forwards unmatched queries to public resolvers, so publishing it on `0.0.0.0` would stand up an open recursive resolver). `adminer` gets a `profiles: ["adminer"]` gate (no published port, HTTPS + basic auth via Traefik) so a plain `up -d` never starts it; see [Optional: Adminer](#optional-adminer). See [the Compose Spec merge rules](https://github.com/compose-spec/compose-spec/blob/master/13-merge.md) if you need to add another overridden list.

## Configuration

Every value can be set as an environment variable ahead of time (for scripted/CI installs); if unset and a terminal is attached, you're prompted; if unset and non-interactive, a safe default is generated where one exists (never for the domain — see below).

| Variable                              | Required | Default                                                                                                                |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `VEXLYX_DOMAIN`                       | **Yes**  | none — the installer exits with instructions if unset and non-interactive                                              |
| `VEXLYX_BASE_DOMAIN`                  | No       | `$VEXLYX_DOMAIN` — set separately if deployed-project subdomains should live in a different zone than the panel (F5.9) |
| `VEXLYX_ADMIN_EMAIL`                  | No       | `admin@$VEXLYX_DOMAIN`                                                                                                 |
| `VEXLYX_ADMIN_PASSWORD`               | No       | randomly generated, printed once at the end                                                                            |
| `VEXLYX_MAIL_HOSTNAME`                | No       | `mail.$VEXLYX_DOMAIN`                                                                                                  |
| `VEXLYX_MAIL_DOMAIN`                  | No       | `$VEXLYX_DOMAIN`                                                                                                       |
| `VEXLYX_ENABLE_PUBLIC_DNS`            | No       | `false` — leaves port 53 closed in UFW and bound to loopback                                                           |
| `VEXLYX_HOME`                         | No       | `/opt/vexlyx`                                                                                                          |
| `VEXLYX_REPO_URL` / `VEXLYX_REPO_REF` | No       | the Vexlyx repo / `latest` (the newest stable release tag; see "Which version is installed")                           |

The API receives `HOSTED_MAIL_HOSTNAME=$VEXLYX_MAIL_HOSTNAME` and
`HOSTED_MAIL_DOMAIN=$VEXLYX_MAIL_DOMAIN` so the dashboard can reproduce the installer's inbound
mail DNS checklist without assuming `mail.$VEXLYX_DOMAIN`. These are deliberately separate from
the API's `MAIL_DOMAIN`, which controls the sender domain for panel transactional email. The API
also receives `COOKIE_DOMAIN=$VEXLYX_DOMAIN` (set directly in `docker-compose.prod.yml`, not
user-configurable) — see [Cross-subdomain session cookie](#cross-subdomain-session-cookie) below.

`VEXLYX_PUBLIC_IP` is not a config prompt — the installer auto-detects it on every run (external IP-echo services, falling back to the local route's source address) and persists it to `/etc/vexlyx/vexlyx.env`, from where it flows into the api container as `PUBLIC_IP` for DNS-onboarding guidance (F5.9, see `docs/dev/dns-onboarding.md`). Set it manually in that file if detection fails (e.g. an offline install).

## Secrets

`/etc/vexlyx/vexlyx.env` (mode `0600`) holds `SESSION_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD`, plus the collected domain/admin-email/mail-hostname config. It's generated exactly once — re-running the installer never rotates it, so a re-run can't invalidate existing sessions or encrypted data. It lives outside the git checkout specifically so an upgrade (`git pull`) never touches it. The admin password is **not** persisted anywhere — it's applied to the database (Argon2id-hashed) and, if auto-generated, shown once on the operator's terminal in the final summary (never through the `tee` into `install.log`).

## Pinned NodeSource key

Step 04 installs Node.js from `https://deb.nodesource.com/node_22.x` using a keyring in `/etc/apt/keyrings/nodesource.gpg` and a `signed-by` sources entry; no remote script is executed. The downloaded key is only trusted when the file holds **exactly one** public key (one `pub` record, no secret key) and that key's fingerprint equals the one in `system/scripts/install/nodesource.fingerprint`; otherwise the step aborts before touching apt. Both conditions are needed because `gpg --dearmor` converts the whole file into the keyring apt trusts: checking only the first fingerprint would let a second key appended after the genuine one be trusted as well. `tests/test_installer_runtime.py` runs the step against real key files, including the pinned key followed by (and preceded by) a second key, which must be refused.

To update the pin (NodeSource rotated its key, or you are moving to a new Node major version):

1. Download the key: `curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o key.asc`.
2. Print the fingerprint: `gpg --show-keys --with-colons key.asc | awk -F: '$1 == "fpr" { print $10; exit }'`.
3. Confirm it out-of-band (NodeSource's installation instructions at https://github.com/nodesource/distributions) before committing it.
4. Put it in `nodesource.fingerprint`. For a new Node major, also change `NODESOURCE_MAJOR` in `steps/04-runtime.sh` and the `>= 22` check.

Until the pin is updated, installs fail closed on a rotated key rather than trusting it.

## Optional: Adminer

Not part of the default install. After installing, `sudo bash /opt/vexlyx/system/scripts/enable-adminer.sh` serves Adminer at `https://adminer.$VEXLYX_DOMAIN` behind Traefik basic auth and adds two optional keys to `/etc/vexlyx/vexlyx.env`: `ADMINER_BASIC_AUTH` (htpasswd entry for the Traefik middleware) and `ADMINER_URL` (passed to the api container so the panel shows the link). Because the installer never rewrites an existing secrets file, they survive re-runs and upgrades. `--disable` removes both and stops the container. Full details and troubleshooting: `docs/dev/database-provisioning.md`.

## Cross-subdomain session cookie

The dashboard (`$VEXLYX_DOMAIN`) and API (`api.$VEXLYX_DOMAIN`) are separate origins. `createSession()` in `apps/api/src/plugins/auth.ts` sets the `vexlyx_session` cookie with an explicit `Domain` attribute (`COOKIE_DOMAIN` env var, set to `$VEXLYX_DOMAIN`) specifically so both subdomains can read it — without it, the cookie defaults to host-only scope on whichever origin set it, and the dashboard's server-side auth guards (`(panel)/layout.tsx`, `(standalone)/layout.tsx`, which fetch `/api/auth/me` forwarding the cookie manually) never see it, redirecting to `/login` even when the user just successfully logged in. `destroySession()`'s `clearCookie` call uses the same `domain` so logout actually clears the right cookie instead of setting an unrelated host-only one. Unset for local dev, where dashboard and API are both plain `localhost`.

## Extending

To add a new step, drop a numbered file in `system/scripts/install/steps/` (it's sourced into the same shell as everything else, so `lib.sh`/`config.sh` helpers and prior steps' exported variables are already in scope) and renumber the banner counts (`grep -rn "log_step.*\[.*\/16\]"`) if you're inserting rather than appending.

## Security notes

- **The api container runs as root.** It needs `/var/run/docker.sock` for Docker-outside-of-Docker, and socket access is already root-equivalent on the host (anyone who can reach it can `docker run --privileged`) — restricting the container's internal UID would add configuration complexity (matching the host's docker.sock group GID) without a real additional security boundary. The dashboard container has no such requirement and runs as an unprivileged user.
- **Interactive prompts only work when stdin is a real TTY.** A plain `curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash` has no TTY on stdin (bash is reading the script itself from that pipe), so `VEXLYX_ADMIN_PASSWORD` and friends fall back to generated defaults there by design — this is deliberate, not a bug. To be prompted interactively, download the script first: `curl -fsSL https://vexlyx.atlantiqs.org/install.sh -o install.sh && sudo bash install.sh`.
- **The admin password is never persisted or logged** — only its Argon2id hash reaches the database. `run.sh` keeps the real stdout on fd 3 before starting the `tee` into `install.log`, and the summary writes a generated password via `show_secret_to_operator`, so the log only gets a placeholder. fd 3 is used only when it is a real terminal (`[[ -t 3 ]]`): if the installer's output was redirected (`> file`, `| tee`, a CI log) fd 3 is that file or pipe and the password must not go there. Otherwise the helper falls back to `/dev/tty`, and with no terminal at all it refuses, nothing secret is printed, and the summary prints guidance for creating a new admin instead. The summary shows a password only when step 13 reported `Created admin user:`; on a re-run the existing account is untouched and a freshly generated password would be meaningless.
- **`install.log` from older installs may contain the password.** Installs made before this change logged it; delete `/etc/vexlyx/install.log` (or the line) on those servers.
- **UFW rules are added before the firewall is enabled**, and the SSH rule is verified present immediately before `ufw --force enable` — a detection failure aborts rather than risking a lockout.
- **`adminer`** (a raw DB browser, fine for dev) is gated behind `--profile adminer` in the prod overlay (no published port; served only via Traefik over HTTPS behind basic auth) so a plain `up -d` never starts it. Opt in with `sudo bash system/scripts/enable-adminer.sh` (`--disable` to undo). The API also reports Adminer as unavailable in production unless `ADMINER_URL` (set in the secrets file, passed through `docker-compose.prod.yml`) is a non-local HTTPS URL; the install summary tells the operator this. See `docs/dev/database-provisioning.md`.
- **Step 09 refuses to build if `apps/api/.env` exists.** Prisma Client auto-loads a `.env` from its working directory at runtime, regardless of `NODE_ENV` or how the process was actually started — a leftover dev `.env` (e.g. from a manual `pnpm dev` run predating the installer) with `VEXLYX_MOCK_DNS=true` was found in the wild to silently defeat real DNS-based domain verification (`domains/service.ts`'s `isMockTest` check reads `process.env.VEXLYX_MOCK_DNS` directly) even with Docker Compose correctly setting `NODE_ENV=production`. Nothing in the production stack is supposed to use a `.env` file at all — config comes entirely through `environment:` blocks — so the installer treats one existing as untrusted state and stops rather than building on top of it.

## Testing

Validated by syntax-checking every script (`bash -n`) and by a real end-to-end install on a fresh Ubuntu (24.04-class) EC2 instance through to a working login and a deployed WordPress project. The full checklist:

1. Fresh VM → `VEXLYX_DOMAIN=... VEXLYX_ADMIN_EMAIL=... bash install.sh` completes without errors — ✅ (after the fixes below)
2. Re-running the same command → no errors, no duplicate UFW rules/secrets/containers — ✅
3. Visit `https://$VEXLYX_DOMAIN` → dashboard login page loads over a real Let's Encrypt cert — ✅
4. Log in with the admin credentials → lands on and stays on `/dashboard` — ✅
5. `docker compose -f docker-compose.yml -f docker-compose.prod.yml ps` → all services healthy — ✅
6. `ufw status` → exactly the expected allow rules, SSH never blocked — ✅
7. Create a project, one-click install WordPress, add a custom domain → all functional — ✅

### Bugs found during the real install, and their fixes

Every one of these is already fixed in the current scripts/Dockerfiles — listed here so the reasoning isn't lost and so a future regression is recognizable.

**Installer / build pipeline:**

- **Node 20 → 22.** pnpm 11 (pinned in `package.json`) uses the `node:sqlite` built-in, added in Node 22 — failed with `ERR_UNKNOWN_BUILTIN_MODULE` on Node 20. Fixed in step 04 (NodeSource 22.x), both Dockerfiles' base images, and root `engines.node`.
- **`config.sh` unbound variable under `set -u`.** The admin-password prompt block referenced `${VEXLYX_ADMIN_PASSWORD}` without a `:-` default on one line; when stdin isn't a TTY (any non-interactive `ssh host 'command'` invocation), the variable is genuinely unset and `set -u` aborts. Fixed by adding the missing `:-`.
- **`@vexlyx/shared`/`@vexlyx/api` build race.** Turbo's `dependsOn: ["^build"]` didn't reliably serialize a fresh checkout's build graph — `tsc` for `api`/`dashboard` started before `shared` had written `dist/`, failing with `Cannot find module '@vexlyx/shared'`. Fixed by building `packages/shared` explicitly before the full `pnpm build` in step 09.
- **Stale `tsconfig.tsbuildinfo` from an interrupted prior attempt.** `tsc --build` trusts its incremental state file even when the `dist/` it refers to no longer exists, silently skipping emit. Fixed by wiping `dist`/`tsconfig.tsbuildinfo` for the TS composite projects at the start of every build (step 09) — recovery from a failed run can never depend on what debris that run left behind.
- **Pre-existing ESLint errors in F2.8's file-manager UI** (unused imports, unnecessary regex escapes) — unrelated to F5.1, but `next build` runs ESLint strictly and nothing had ever exercised a real production build before. Fixed in the source files directly.
- **`turbo prune --docker` doesn't copy the monorepo root `tsconfig.json`.** `packages/shared/tsconfig.json`'s `extends: "../../tsconfig.json"` silently failed to resolve inside the pruned Docker build context, so `tsc` fell back to an ES5-ish default lib and failed on `String.prototype.startsWith`/`includes`. Fixed by explicitly `COPY`-ing the root `tsconfig.json` into `apps/dashboard/Dockerfile`'s builder stage.
- **`apps/dashboard/public/` never existed.** The runtime stage's `COPY --from=builder .../public ...` fails hard on a nonexistent source. Fixed by adding the directory (with a `.gitkeep`) to the repo.

**Runtime / networking:**

- **`ufw show added` vs `ufw status` for the pre-enable SSH check.** `ufw status` only lists rules once the firewall is _active_ — checking it before `ufw --force enable` (deliberately, to avoid a lockout) always showed no rules even though they were really added. Fixed by using `ufw show added`, which lists configured rules regardless of active state.
- **Traefik v3.4 incompatible with Docker 29+.** Docker 29 raised its minimum accepted API version; Traefik ≤3.5's Docker provider hardcodes API 1.24 for its client (ignoring `DOCKER_API_VERSION` entirely) and gets rejected outright, so it never syncs container labels and never creates any routers — every request 404s. Fixed by bumping the pinned image to `traefik:v3.6` (which added API auto-negotiation) in `docker-compose.yml`.
- **`acme.json` auto-created at `644`.** It's gitignored, so a fresh checkout doesn't have it; Docker Compose bind-mounting a missing file auto-creates it as root:root `644`, and Traefik refuses to use an ACME storage file that isn't exactly `600`, silently disabling the `letsencrypt` resolver for every router. Fixed by having step 07 `touch` + `chmod 600` it before services come up.
- **Missing `python` → `python3` symlink inside the API image.** Several call sites (`apps/api/src/modules/{build,deploy,wordpress,dockerfile,databases}/service.ts`) spawn Python as literally `python`; Debian ships no such binary. Host-side installer already handled this (step 04) but the API container's own image didn't. Fixed by adding the same symlink to `apps/api/Dockerfile`.
- **Missing `docker-buildx-plugin` inside the API image.** Modern Docker defaults `docker build` to BuildKit, which Nixpacks' build step invokes from inside the API container — failed with "BuildKit is enabled but the buildx component is missing or broken". Fixed by adding `docker-buildx-plugin` alongside `docker-ce-cli`/`docker-compose-plugin` in `apps/api/Dockerfile`.
- **Session cookie not shared across the dashboard/API subdomains.** See [Cross-subdomain session cookie](#cross-subdomain-session-cookie) — fixed with the new `COOKIE_DOMAIN` env var.
- **Stray `apps/api/.env` silently defeating domain verification.** See the security note above — fixed by having step 09 refuse to build if the file exists.

**Pre-existing application bugs, unrelated to F5.1 itself, surfaced by finally running this stack for real:**

- `system/python/build_manager.py` had a JS-style `null` in a type annotation (`str | null` instead of `str | None`) — Python evaluates annotations at function-definition time, so this crashed the script's very first import with `NameError`, breaking every project build and one-click install. Fixed in place.
- `EnvVarEditor.tsx`'s "Add Variable" form had no `autoComplete` attributes, so Chrome's saved-login heuristics offered to autofill the site's own admin credentials into an unrelated Key/Value pair. Fixed with `autoComplete="off"` / `"new-password"`.

## Panel email (F5.23)

The installer passes `MAIL_DOMAIN` (the panel domain), `MAIL_REPLY_TO` (the admin email) and `BUNDLED_SMTP_HOST=postfix` to the API container, so password resets and notifications are relayed through the bundled Postfix as `notifications@<panel domain>` with no extra setup. The install summary keeps this SPF/DKIM/DMARC guidance separate from the mail-host A and mail-domain MX records required for inbound hosted mail. Settings → System Email lists and checks the transactional-email authentication records. See [System Transactional Email](system-transactional-email.md).
