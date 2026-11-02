<div align="center">

# Vexlyx

**The open-source hosting control panel for modern apps *and* traditional hosting.**

Deploy Next.js, Node.js, Python, React, static sites and WordPress — and run email, DNS, domains and databases — from one dashboard on one server.

[![CI](https://github.com/atlantiqshq/vexlyx/actions/workflows/ci.yml/badge.svg)](https://github.com/atlantiqshq/vexlyx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](https://nodejs.org)

[Documentation](https://docs.vexlyx.atlantiqs.org) · [Install on a server](#-install-on-a-server) · [Develop locally](#-develop-locally) · [Contributing](./CONTRIBUTING.md)

</div>

---

## What is Vexlyx?

Most panels are either a PaaS (great for apps, no mail or DNS) or a classic cPanel clone (great for mailboxes, awkward for a Next.js app). Vexlyx is both, on a single box you own.

| | |
|---|---|
| **Deploy apps** | Connect a Git repo (or the GitHub integration), Nixpacks builds it, Traefik routes it with automatic SSL. |
| **Host websites** | Static sites, WordPress and no-build PHP, served through nginx. |
| **Run email** | Postfix + Dovecot + Roundcube with DKIM, SPF and DMARC scoring per domain. |
| **Manage DNS & domains** | CoreDNS zones, nameserver delegation checks, subdomains, custom domains. |
| **Provision databases** | PostgreSQL and MySQL databases per project, with Adminer. |
| **Operate safely** | Roles (admin / reseller / user), 2FA, audit log, firewall, backups, live logs and monitoring. |

---

## 🚀 Install on a server

On a fresh **Ubuntu 24.04** server with your domain's A record already pointing at it:

```bash
VEXLYX_DOMAIN=panel.yourdomain.com \
VEXLYX_ADMIN_EMAIL=you@yourdomain.com \
  curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
```

The installer sets up Docker, Node.js, Python and Nixpacks, brings up Postgres, Redis, Traefik (real Let's Encrypt certificate), CoreDNS, the mail stack and the panel itself, creates the admin user and configures the firewall. It is safe to re-run. Details: [docs/dev/installer.md](./docs/dev/installer.md).

---

## 💻 Develop locally

### Quick start

You need **Node.js 22+**, **pnpm**, **Docker** (running) and **Git**. Python 3 is optional.

```bash
git clone https://github.com/atlantiqshq/vexlyx.git
cd vexlyx
corepack enable        # makes the pinned pnpm version available
pnpm bootstrap         # one-time setup, see below
pnpm dev
```

Then open **http://localhost:3000** and sign in:

| Email | Password | Role |
|---|---|---|
| `admin@vexlyx.local` | `admin123` | Admin |
| `reseller@vexlyx.local` | `admin123` | Reseller |
| `sub-account@vexlyx.local` | `admin123` | User (under the reseller) |

> These accounts exist only in your local development database.

### What `pnpm bootstrap` does

It is a single cross-platform script ([scripts/dev-setup.mjs](./scripts/dev-setup.mjs)) that replaces the manual checklist:

1. Verifies Node, pnpm, Git, Docker (and that the daemon is running) and tells you how to fix anything missing.
2. Creates `apps/api/.env` and `apps/dashboard/.env.local` from the examples, with **freshly generated** `SESSION_SECRET` and `ENCRYPTION_KEY`.
3. Creates the external `traefik-net` and `vexlyx-apps` Docker networks and the `acme.json` file Traefik mounts.
4. Runs `pnpm install`.
5. Starts **Postgres, Redis and Traefik** and waits until they are healthy.
6. Generates the Prisma client, applies migrations and seeds the development users.

It never overwrites an existing `.env`, so it is safe to re-run. If port 5432 is already taken by a local Postgres, it moves Vexlyx's database to 5433 and keeps the env files in sync.

```bash
pnpm bootstrap --check     # only verify prerequisites
pnpm bootstrap --full      # also build mail, DNS, MySQL, webmail and Adminer
pnpm bootstrap --help
```

### Day-to-day commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dashboard (`:3000`) and API (`:5000`) in watch mode |
| `pnpm infra:up` / `pnpm infra:down` | Start / stop the core Docker services |
| `pnpm db:studio` | Browse the database in Prisma Studio |
| `pnpm typecheck` | TypeScript strict check across the monorepo |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest suites (Python system tests live in `tests/`) |
| `pnpm build` | Production build — must pass before a PR |
| `pnpm format` | Prettier |

Database commands run against the API package: `pnpm --filter @vexlyx/api db:migrate`, `db:seed`, `db:reset`.

### Local services

| Service | URL / port | Started by |
|---|---|---|
| Dashboard | http://localhost:3000 | `pnpm dev` |
| API | http://localhost:5000 (`/api/health`) | `pnpm dev` |
| Traefik dashboard | http://localhost:8080 | `pnpm infra:up` |
| PostgreSQL | `localhost:5432` | `pnpm infra:up` |
| Redis | `localhost:6379` | `pnpm infra:up` |
| Adminer, MySQL, webmail, mail, DNS | `:8088`, `:3306`, `:8089`, `:25/587/143`, `:53` | `pnpm bootstrap --full` |

Most features only need the core three. You only need `--full` when working on mail, DNS or database provisioning.

### Troubleshooting

<details>
<summary><strong>Docker says <code>network traefik-net</code> (or <code>vexlyx-apps</code>) <code>declared as external, but could not be found</code></strong></summary>

Run `docker network create traefik-net` and `docker network create vexlyx-apps`, or just use `pnpm bootstrap` which does it for you.
</details>

<details>
<summary><strong>Port 5432, 6379, 80 or 8080 is already in use</strong></summary>

For Postgres, `pnpm bootstrap` switches to 5433 automatically. For the others, stop the other process, or run only what you need. Compose reads a root `.env`, so `POSTGRES_HOST_PORT=5433` there also works.
</details>

<details>
<summary><strong>The API fails with a Prisma or database connection error</strong></summary>

Check `docker compose ps` shows `vexlyx-postgres` as healthy, and that `DATABASE_URL` in `apps/api/.env` uses the same port Compose published. Then run `pnpm --filter @vexlyx/api db:generate`.
</details>

<details>
<summary><strong>Start from a clean database</strong></summary>

```bash
pnpm --filter @vexlyx/api db:reset
```
</details>

<details>
<summary><strong>Windows</strong></summary>

Use Docker Desktop with the WSL 2 backend. Everything runs from PowerShell, Git Bash or WSL. Docker-managed mail volumes behave best when the repo lives inside your normal user folder.
</details>

---

## 🧱 How it is built

```
┌────────────┐   REST + Socket.io   ┌────────────┐   subprocess   ┌──────────────────┐
│ Dashboard  │ ───────────────────▶ │    API     │ ─────────────▶ │ system/python/*  │
│ Next.js 15 │                      │  Fastify   │                │ Docker, mail, DNS│
└────────────┘                      └─────┬──────┘                └──────────────────┘
                                          │ Prisma / BullMQ
                                   ┌──────┴───────┐
                                   │ Postgres·Redis│
                                   └──────────────┘
```

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), Tailwind CSS 4, shadcn/ui, Zustand, TanStack Query |
| Backend | Fastify, Prisma, BullMQ, Socket.io, Zod |
| Auth | Argon2id + Redis sessions in HTTP-only cookies, optional TOTP 2FA |
| Runtime | Docker Compose, Traefik v3, Nixpacks |
| System layer | Python scripts (Docker, Postfix, Dovecot, CoreDNS, backups) |
| Monorepo | pnpm workspaces + Turborepo |

### Repository layout

```
vexlyx/
├── apps/
│   ├── dashboard/     Next.js frontend
│   └── api/           Fastify backend — src/modules/<feature>/{routes,service,schema}.ts
├── packages/
│   └── shared/        Zod schemas + types used by both apps
├── system/            Python + Bash system layer, installer, service templates
├── docker/            Traefik, CoreDNS, Postfix, Dovecot, Roundcube configs
├── docs/              Public docs site + per-feature developer docs (docs/dev)
├── scripts/           Local development tooling (dev-setup.mjs)
└── tests/             Python system-layer tests
```

---

## 🤝 Contributing

1. Run `pnpm bootstrap` and `pnpm dev`.
2. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and skim [CLAUDE.md](./CLAUDE.md) for conventions (it's the project's rulebook, for humans and AI assistants alike).
3. Pick something from [FEATURES.md](./FEATURES.md) or open an issue.
4. Before opening a PR make sure `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.

More reading: [docs/dev/](./docs/dev/) has one page per feature (what it does, how it works, how to test and extend it). [DEV.md](./DEV.md) describes the AI-assisted workflow used on this project. Security issues: see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
