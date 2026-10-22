# No-Build PHP Hosting (F5.21)

A PHP project with no `composer.json` and no `buildCmd` now deploys the same
way HestiaCP/CyberPanel/cPanel work — files go straight into a running
PHP-FPM pool, no build step — generalizing F5.7's WordPress two-container
(PHP-FPM + nginx) pattern instead of WordPress's fixed official image. A PHP
project that *does* have a `composer.json` is unaffected and keeps building
via Nixpacks exactly as before.

## Why

Nixpacks' own PHP provider only recognizes a project as PHP when it finds a
`composer.json` **or** an `index.php`. Vexlyx's own detection
(`detect_php_project` in `build_manager.py`) is more lenient — it also
accepts bare `.php` files with no framework/dependencies — so a project like
a Duplicator (WordPress migration) backup (`installer.php` + a site `.zip`,
no `composer.json`) passed Vexlyx's detection but failed Nixpacks' real build
with "unable to generate a build plan."

## Extensions: a custom `vexlyx-php-fpm` image

The official `php:8.3-fpm-alpine` base is bare — no `mysqli`, `zip`, `gd`,
`mbstring`, etc. Rather than ship that directly or install extensions at
every container start, Vexlyx builds a small custom image once at install
time:

- **`docker/php-fpm/Dockerfile`** — `php:8.3-fpm-alpine` +
  `mysqli pdo_mysql zip gd exif mbstring intl` via `docker-php-ext-install`.
  `zip` in particular is required for the Duplicator case itself — the
  migration archive is extracted by PHP, not by Vexlyx.
- Built by `system/scripts/install/steps/10-images.sh` as `vexlyx-php-fpm:8.3`,
  the same pattern already used for `vexlyx-ufw-helper` (F5.4).
- Configurable via `PHP_FPM_IMAGE` (`apps/api/src/config/env.ts`, default
  `vexlyx-php-fpm:8.3`) if an operator wants to swap in their own image.

PHP version is fixed at 8.3 for this path — one baked image, no per-project
version selection, matching WordPress's fixed `wordpress:php8.3-fpm-alpine`.
Nixpacks-built PHP (`composer.json` present) is unaffected and keeps its
existing per-project version detection (`detect_php_version`).

## Compose shape

`system/templates/docker-compose/php-no-build.yml` — two services, modeled
on `wordpress.yml`'s shape but bind-mounting the project's own source
directory instead of a named volume:

- **`app`** (PHP-FPM): `{{php_root}}:/var/www/html`, **read-write**. Unlike
  STATIC's read-only bind mount, this has to be writable — a self-installing
  script like Duplicator's `installer.php` extracts its archive and writes
  its own files into the docroot as part of running. A read-only mount would
  make that fail outright.
- **`web`** (nginx, Traefik-facing): same directory, `:ro` — nginx only ever
  reads. This read-write/read-only asymmetry mirrors `wordpress.yml`'s `app`
  vs `web` volumes exactly.

## Nginx config

### Which paths are served

A no-build site serves the whole project directory, which also holds the
panel's generated `deploy/` files and whatever dot files the repository has.
Both `php.conf.template` and `spa.conf.template` (no-build static/React, which
serve the project directory the same way) therefore answer `404` for the exact
`deploy/` directory and for any path segment that starts with a dot, except
`/.well-known/` (ACME challenges, `security.txt`, app links). `deployment.txt`
or `mydeploy/` are ordinary names and stay public. The rules sit before the PHP
handler and use `^~` for `deploy`, so nothing can reach them through a regex
location, and nginx decodes and normalises the URI first, so `%64eploy`,
`//deploy`, `/./deploy` and `/x/../deploy` are covered as well.
`tests/test_nginx_served_paths.py` renders both templates, runs them in a
disposable `nginx:alpine` over a docroot holding `deploy/docker-compose.yml`,
`deploy/nginx.conf`, `.git/config`, `.env` and friends, and requests 20 spellings
that must be `404` and 8 public paths that must stay `200`.

`nginx.conf` is generated into `deploy/` at deploy time, so existing sites keep
the old one until redeployed. `docker_manager.py refresh_nginx_conf` (run once
per upgrade by installer step 14 through `apps/api/src/scripts/refresh-nginx-confs.ts`,
guarded by `workspaces/.migrations/nginx-served-paths-v1`) re-renders it for
every no-build static, React and PHP site, in place (the container bind-mounts
that single file, so the inode must stay) and only when the content changed,
then reloads nginx. nginx keeps serving the old config if the new one fails its
own test, a symlinked `deploy/` or `nginx.conf` is skipped, and one failing site
never blocks the others.

### Front controller

`system/templates/nginx/php.conf.template` falls back unmatched URIs to
`index.php`, the standard front-controller pattern most real PHP apps need:

```
location / { try_files $uri $uri/ /index.php?$args; }
location ~ \.php$ { fastcgi_pass {{app_upstream}}:9000; ... }
```

This was originally a hard `=404` instead — deliberately *not* a
WordPress-style rewrite, reasoning that arbitrary PHP entry files (like
Duplicator's `installer.php`) should be servable directly by URL rather than
silently redirected. That reasoning was wrong in practice: `try_files`
already matches a real file (`installer.php`) on its *first* check and never
reaches the `index.php` fallback, so direct-file access was never actually at
risk. Meanwhile the hard `=404` broke the far more common case — a real
WordPress site (e.g. migrated in-place by Duplicator) needs pretty permalinks
like `/about-page/` to resolve through `index.php`, and those aren't real
files/directories on disk. Found live: `wp-login.php` worked (a real file)
but every pretty-permalink page 404'd. A project with no `index.php` at all
still gets a clean 404 for a missing path, via the `.php` location's own
`try_files $uri =404;` guard.

`client_max_body_size 512m` — higher than WordPress's 64m, since migration
archives run larger.

The `web` healthcheck (`wget ... ; test $$? -ne 4`) treats a reachable-but-404
response as healthy — there's no guaranteed index page for an arbitrary PHP
project, so only an actual connection failure (exit 4) counts as unhealthy.

## Four bugs found live, testing a real Duplicator migration

The synthetic single-`index.php` test that shipped with this feature didn't
catch any of these — they only surfaced running a real ~26k-file WordPress
migration through Duplicator. All four are fixed in the templates below;
`docs/dev/` is the record of *why*, since none of this is obvious from
reading the config alone.

**1. `fastcgi_read_timeout` (60s default) killed the migration extraction.**
Duplicator's AJAX-chunked extraction of 25,760 files ran past nginx's default
60s fastcgi timeout, surfacing to the browser as `AJAX ERROR! STATUS: 504`.
Fixed by setting `fastcgi_connect_timeout`/`fastcgi_send_timeout`/
`fastcgi_read_timeout` to `300s` in `php.conf.template` — this feature exists
specifically for long-running migration-style work, so a generous timeout is
the correct default here, not a special case.

**2. PHP never sees `$_SERVER['HTTPS']`, so WordPress redirect-loops on
`wp-login.php`.** Traefik terminates TLS at the edge and always proxies to
the `web` (nginx) container over plain HTTP — nginx→PHP-FPM is plain HTTP
too. PHP has no way to know the original request was HTTPS unless told, so
`is_ssl()` always returns false. A migrated site with an `https://` `siteurl`
(or any app enforcing HTTPS on login/admin) redirects to `https://` on every
request, and since PHP still thinks it's HTTP next time, it redirects again —
forever. Fixed with the standard reverse-proxy recipe: a `map
$http_x_forwarded_proto $fastcgi_https` block translating Traefik's
(correctly-sent) `X-Forwarded-Proto` header into the `HTTPS` fastcgi param
PHP actually checks. Applied to **both** `php.conf.template` and
`wordpress.conf.template` — F5.7's WordPress path has the exact same latent
bug, just never hit it because nothing forced an HTTPS-only redirect before.

**3. Docker Compose auto-aliases `app`/`web` on the *shared* `traefik-net`
network, so two two-container projects collide.** This is the serious one.
Every compose template names its services `app`/`web` — a Compose-generated
alias `app` therefore gets registered on `traefik-net` for *every* project
that has an `app` service, but `traefik-net` is one shared external network
across the whole install, not scoped per project. With two no-build PHP (or
WordPress) projects deployed at once, `fastcgi_pass app:9000` resolves
**ambiguously** — Docker's embedded DNS round-robins between both projects'
`app` containers, so nginx randomly proxies PHP execution to a *different
project's* php-fpm container. Confirmed live with `getent hosts app` from
inside one project's `web` container returning the other project's IP, and
`index.php`/`wp-login.php` requests alternating between two completely
different responses request-by-request. This is a cross-tenant correctness
bug, not just a flaky one.

  Fixed by addressing each project's `app` container by its own unique,
  Compose-generated container name (`vexlyx-<service_name>-app-1`, deterministic
  from the compose project's `name:` field + service name) instead of the
  ambiguous bare service name. `docker_manager.py`'s `cmd_deploy` computes
  `app_upstream = f"vexlyx-{service_name}-app-1"` and `generate_nginx_conf`
  now accepts placeholder substitution (previously it just copied the
  template verbatim) so `{{app_upstream}}` can be injected into both
  `php.conf.template` and `wordpress.conf.template`.

  This bug applies to WordPress (F5.7) as much as no-build PHP (F5.21) — any
  Vexlyx install running 2+ WordPress and/or no-build-PHP projects
  simultaneously was exposed before this fix. `web`'s alias has the identical
  collision but is harmless today, since nothing resolves `web` by DNS name
  (Traefik discovers containers via Docker labels, not internal DNS).

**4. Pretty permalinks (`/about-page/`) 404'd even though the migration
succeeded.** `location /` originally hard-404'd anything that wasn't a real
file/directory, on the reasoning that an arbitrary PHP entry file (like
`installer.php`) should be servable directly by URL rather than silently
rewritten. That reasoning didn't hold up: `try_files` already matches a real
file on its first check, so direct-file access was never actually at risk;
meanwhile the hard `=404` broke the much more common case of an actual
WordPress site, whose non-file URLs need to resolve through `index.php`.
Fixed by changing `location /` to the standard `try_files $uri $uri/
/index.php?$args;` front-controller fallback — verified this doesn't
regress direct file access (`installer.php` still serves directly) or a
genuinely-missing file (`.php` location's own `try_files $uri =404;` guard
still 404s cleanly when there's no `index.php` to fall back to either).

## Wiring: `docker_manager.py` / `build_manager.py`

- **Deploy-time template selection** (`cmd_deploy` in `docker_manager.py`):
  the API service signals "this is a no-build PHP deploy" the exact same way
  it already signals no-build STATIC/REACT — by passing `staticRoot` in the
  deploy payload. When `projectType == "PHP"` and `staticRoot` is present,
  `cmd_deploy` swaps in `php-no-build.yml` and generates `php.conf.template`
  instead of the default `php.yml` (single-container, Nixpacks-built image).
- **`primary_service_name(project_type, compose_dir)`**: WORDPRESS is always
  a two-container split (`web` fronts traffic). PHP is now ambiguous —
  Nixpacks-built PHP is a single `app` container, no-build PHP is `app` +
  `web` — so `project_type` alone can't disambiguate a *redeploy's*
  status/logs/container-id lookup. Instead of persisting a new flag, this
  inspects the already-generated `<projectDir>/deploy/docker-compose.yml` for
  a top-level `web:` service key.
- **`build/service.ts`**: `isPhpNoBuild = effectiveProjectType === "PHP" &&
  !effectiveBuildCmd`, alongside the existing `isStaticNoBuild`/`isWordPress`
  checks — skips `runBuildImage` entirely and sets `staticRoot = projectDir`.
- **`deploy/service.ts`**: the independent "redeploy without rebuild" path
  (`DeployService.deploy`) gets the same `project.type === "PHP" &&
  !project.buildCmd` check, mirroring its existing STATIC/REACT branch.
- **`build_manager.py`'s composer.json stopgap** (auto-writing an empty
  `composer.json` so Nixpacks can build a composer-less PHP project) is now
  fallback-only: since the no-build path is taken automatically whenever
  there's no `composer.json`/`buildCmd`, `cmd_build` is never invoked for
  that case at all. The stopgap only still matters if a user explicitly
  forces a `buildCmd` override on a composer-less PHP project.

## Known caveat

A project that already had the stopgap `composer.json` auto-written to its
source directory (from before this feature shipped) won't pick up the
no-build path until that file is removed — detection is purely
`composer.json`-presence-based, with no distinction between a "real"
`composer.json` and Vexlyx's own stopgap-written empty one.

## Testing

1. Deploy a project with a single `index.php` and no `composer.json` → no
   Nixpacks build logged, container up in low single-digit seconds.
2. Deploy a Duplicator-style package (`installer.php` + `.zip`, no
   `composer.json`) → installer runs and successfully writes into the
   docroot.
3. Deploy a PHP project with a real `composer.json` (e.g. Laravel) → still
   builds via Nixpacks, unaffected.
4. Redeploy a no-build PHP project (no rebuild) → reuses the bind mount
   without invoking Nixpacks.
5. `docker compose logs`/status/stop/start against a no-build PHP project →
   `primary_service_name` correctly resolves to `web`.
