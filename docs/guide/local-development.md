# Local development

This guide prepares a repeatable Vexlyx development environment and explains the checks expected before a contribution.

## Prerequisites

- Node.js 22 or newer
- Corepack and the repository-pinned pnpm version
- Git
- Docker Engine with Docker Compose v2, or Docker Desktop
- Python 3 when working on the system layer

On Windows, use Docker Desktop with the WSL 2 backend. Run the commands from PowerShell, Git Bash, or WSL consistently so paths and permissions do not drift between environments.

## Bootstrap the repository

```bash
git clone https://github.com/atlantiqshq/vexlyx.git
cd vexlyx
corepack enable
pnpm bootstrap
pnpm dev
```

`pnpm bootstrap` verifies prerequisites, creates local environment files without overwriting existing ones, generates secrets, starts the core Docker services, applies database migrations, and seeds development users.

Open the dashboard at `http://localhost:3000`. The API health endpoint is `http://localhost:5000/api/health`.

## Seeded accounts

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@vexlyx.local` | `admin123` |
| Reseller | `reseller@vexlyx.local` | `admin123` |
| User | `sub-account@vexlyx.local` | `admin123` |

These credentials are only for the local seed database. Never use them in a deployed installation.

## Common commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Run the dashboard and API in watch mode |
| `pnpm infra:up` | Start PostgreSQL, Redis, and Traefik |
| `pnpm infra:down` | Stop core development infrastructure |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm typecheck` | Run strict TypeScript checks |
| `pnpm lint` | Run ESLint and formatting checks |
| `pnpm test` | Run workspace tests |
| `pnpm build` | Build all packages through Turborepo |

Use `pnpm bootstrap --full` only when developing mail, DNS, MySQL provisioning, webmail, or Adminer. Most dashboard and API changes need only the core services.

## Repository layout

| Path | Responsibility |
|---|---|
| `apps/dashboard` | Next.js dashboard and user interface |
| `apps/api` | Fastify API, Prisma access, queues, and orchestration |
| `packages/shared` | Shared Zod schemas and TypeScript types |
| `system/python` | Privileged system operations behind constrained interfaces |
| `docker` | Infrastructure and production service configuration |
| `docs` | VitePress site and engineering documentation |

Start with the [monorepo architecture](/reference/monorepo), then read the reference page for the subsystem you plan to change.

## Before opening a pull request

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --dir docs build
```

Add tests for the happy path, invalid input, and authorization where applicable. Keep changes focused, update the relevant documentation, and follow the repository's [contributing guide](/project/contributing).

## Troubleshooting setup

- Run `pnpm bootstrap --check` to verify prerequisites without changing the environment.
- If PostgreSQL port 5432 is occupied, bootstrap can select 5433 and keep the environment files aligned.
- If Docker reports that `traefik-net` or `vexlyx-apps` is missing, rerun `pnpm bootstrap`.
- If Prisma cannot connect, check `docker compose ps`, compare the published PostgreSQL port with `DATABASE_URL`, and regenerate the client.

For product and production failures, use the [troubleshooting guide](/guide/troubleshooting).
