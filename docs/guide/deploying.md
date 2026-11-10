# Deploying a project

This covers the deploy flow that's the same for every project type — connecting a repo, setting
environment variables, watching a build, and redeploying on push — followed by what each of the
8 project types (Next.js, Node.js, Python, React/Vite, Static, PHP, WordPress, Docker) expects
from your code. For the very first project, see [Getting started](/guide/getting-started).

## The deploy flow

1. **Create the project** and pick its type (Projects → New Project). The type decides which
   build/runtime template Vexlyx uses — see [per-type notes](#per-type-notes) below.
2. **Get code in** — either connect a Git repository, or (for the Docker type) write/upload a
   `Dockerfile` directly in the dashboard.
3. **Build** — Vexlyx runs [Nixpacks](https://nixpacks.com) (or, for Docker projects, a plain
   `docker build`) to detect your framework and produce a container image. Watch it live in the
   project's **Build** tab.
4. **Deploy** — on a successful build, the image is brought up behind Traefik and becomes
   reachable at `https://<project-name>.<your-domain>` immediately, with HTTPS and no DNS setup
   needed on your part.
5. **Redeploy** — either click "Deploy" again in the dashboard, or push a commit to the connected
   branch if you've set up auto-deploy (below).

### Connect a repository

For GitHub, an administrator first creates the panel's GitHub App under **Settings → GitHub**.
Each user can then connect a personal account or organization and choose which repositories the
App may access. When creating or editing a project, select **Import from GitHub**, choose the
repository and branch, and Vexlyx configures private access and push-to-deploy automatically.

The manual Git flow remains available for GitLab, Bitbucket, Gitea, self-hosted servers, and
GitHub repositories that should not use the App. In the project's **Git** settings, enter the
repository URL and branch.

- **Public repos** — paste the HTTPS URL and connect directly.
- **Private repos** — click **Generate SSH Key** first. Vexlyx generates an Ed25519 key pair for
  the project and shows you the public key; add it as a **Deploy Key** in your repository's
  settings (GitHub: Settings → Deploy keys), then connect using the SSH URL
  (`git@github.com:user/repo.git`).

### Auto-deploy on push

GitHub App projects receive push events automatically through the panel-wide App webhook; there
is no per-project webhook to configure. Manual GitHub projects continue to show a **webhook URL**
and **secret** in Git settings. Add those under GitHub → Settings → Webhooks with content type
`application/json` and the `push` event selected.

Every push to the configured branch triggers a build and redeploy. Pushes to other branches are
acknowledged and ignored. See the [GitHub integration reference](/reference/github-integration)
for installation lifecycle, security, and troubleshooting details.

### Environment variables

Set them in the project's **Environment** tab, one at a time or by pasting/importing a whole
`.env` file. Values are encrypted at rest (AES-256-GCM) and masked in the UI until you reveal
them. They're injected as real environment variables into the running container on every deploy;
for frameworks that inline variables into the client bundle at build time (Next.js's
`NEXT_PUBLIC_*`, Vite's `VITE_*`), they're also passed into the build step itself, so you don't
need to redeploy twice after adding one.

### Watching logs

- The **Build** tab streams the build log live as it happens (and replays history if you open it
  mid-build or after it finishes).
- The **Runtime Logs** panel on a running project streams `docker logs --follow` for the
  container — useful for watching a crash loop or debugging startup errors.

## Per-type notes

| Type | Detected by | Internal port | Start command |
|---|---|---|---|
| **Next.js** | `next.config.*`, or `next` in `package.json` | 3000 | `npm run start` (or your lockfile's package manager) |
| **Node.js** | Any other `package.json` (Express, Fastify, plain Node, etc.) | 3000 | From `package.json`'s `start` script, or Nixpacks' default |
| **Python** | `manage.py` (Django), `flask`/`fastapi` in dependencies | 8000 | `gunicorn`/`uvicorn`, auto-resolved from your entrypoint |
| **React (Vite)** | `vite.config.*` + `react`/`@vitejs/plugin-react` | 80 | Static build served by Caddy |
| **Static** | Plain HTML/CSS, or Vite with Vue/Svelte/no framework | 80 | Static build served by Caddy |
| **PHP** | `index.php`/`composer.json`, or `artisan` (Laravel), `bin/console` (Symfony) | 80 | Nginx + PHP-FPM |
| **WordPress** | `wp-config.php`/`wp-content/`, or the 1-click installer | 80 | Nginx + PHP-FPM, `wp-content` persisted across redeploys |
| **Docker** | A `Dockerfile` in the repo (or project type set to Docker) | First `EXPOSE`d port, or your override | Whatever your Dockerfile's `CMD`/`ENTRYPOINT` says |

### Next.js

Works with SSR, API routes/route handlers, SSG/ISR, and `next/image` out of the box. The package
manager is picked from your lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, or
`package-lock.json`). Build cache (`.next/cache`, `node_modules/.cache`) is preserved between
deploys, so later builds are usually 50–80% faster than the first. See the
[Next.js runtime reference](/reference/runtimes/nextjs) for the full detection and compose
template details.

### Node.js

Any repo with a `package.json` that isn't recognized as Next.js, React/Vite, or another
framework is treated as a plain Node app. Make sure your app listens on `process.env.PORT` (not a
hardcoded port) and binds to `0.0.0.0`, not `localhost` — otherwise Traefik can't reach it inside
the container network.

### Python

Django, Flask, and FastAPI are auto-detected and started correctly without configuration:

- **Django** — needs `manage.py`; runs `collectstatic` during build, then `gunicorn
  <module>.wsgi:application`.
- **Flask** — needs `flask` as a dependency; entrypoint resolved from `app.py`/`main.py`/`wsgi.py`
  and started with `gunicorn`.
- **FastAPI** — needs `fastapi` as a dependency; entrypoint resolved similarly and started with
  `uvicorn`.

Pin your Python version with `.python-version`, `runtime.txt`, or `requires-python` in
`pyproject.toml` if you need something other than the default. See the
[Python runtime reference](/reference/runtimes/python) for exact detection rules per framework.

### React (Vite) and other static sites

Vite apps (React, Vue, Svelte, or plain) build to `dist/` and are served as static files with
client-side routing fallback already configured, so React Router / TanStack Router work on a hard
refresh. `VITE_*` env vars are baked into the bundle at build time. If your build outputs
somewhere other than `dist/`, set `NIXPACKS_SPA_OUTPUT_DIR` in the project's environment
variables. Plain HTML/CSS sites with no `package.json` are also supported and served the same
way.

### PHP, Laravel, and Symfony

Generic PHP, Laravel (`artisan`), and Symfony (`bin/console`) are all auto-detected, with the
right web root (`/app/public` for Laravel/Symfony) and PHP version (from `composer.json`,
`.php-version`, `runtime.txt`, or an env var — defaulting to 8.2) picked automatically. Pretty
URLs work without extra `.htaccess` setup.

### WordPress

Create a project with type **WordPress** and use the dashboard's WordPress panel to 1-click
install: it downloads WordPress core, generates secure salts, and wires up `wp-config.php`
against a database you provide. `wp-content` (uploads, themes, plugins) is mounted as a
persistent volume, so it survives redeploys. Plugin and theme ZIPs can be uploaded directly from
the same panel. See [PHP & WordPress runtime reference](/reference/runtimes/php-wordpress) for
the installer details and API.

### Docker (custom Dockerfile)

For anything the above don't cover — Go, Rust, Bun, or a stack with unusual build steps — create
a project of type **Docker** and write (or paste) a `Dockerfile` in the project's Dockerfile
panel; starter templates are available for common stacks. Vexlyx runs a plain `docker build`,
reads your `EXPOSE` directive to know which port to route traffic to, and passes your project's
environment variables in as `--build-arg`s. A `.dockerignore` is supported the same way it would
be locally.

## Next steps

- [Domains, subdomains and SSL](/guide/domains-and-ssl) — replace the generated subdomain with
  your own.
- [Troubleshooting](/guide/troubleshooting#deploys-and-builds) — build/deploy problems and what to
  check first.
- [Databases](/reference/database-provisioning) — provision a database for your project.


### Advanced build settings

The project Deploy tab exposes runtime version selectors for Nixpacks. They write the same `NIXPACKS_NODE_VERSION`, `NIXPACKS_PYTHON_VERSION` and `NIXPACKS_PHP_VERSION` entries as Environment Variables. **Auto** deletes that override and returns to existing environment/repository detection. Other environment entries and command overrides are left unchanged. Custom Dockerfiles select their own runtimes.

**Base directory** is a relative application directory such as `apps/web`. Detection, image builds and static extraction use it; Git still synchronizes the whole repository and deployment metadata stays in the project root. Paths outside the project, traversal, and generated/internal directories are rejected. Clearing the setting returns to the repository root. For WordPress, the selected directory's `wp-content` is mounted.

**Container memory limit** accepts values such as `512m` or `1g`, up to `64g`. Blank uses the server's `DEPLOY_MEMORY_LIMIT`. This controls running containers, not the build process.

Disable **Enable build cache** to pass `--no-cache` to Nixpacks or Docker builds. **Clear build cache** assigns this project a new cache namespace and makes its next successful image build bypass cached layers. A failed build keeps the reset pending. It does not prune shared Docker cache or reclaim disk from other projects. See [Nixpacks cache options](https://nixpacks.com/docs/configuration/caching).
