# CLAUDE.md

> **Project:** Vexlyx
> **Purpose:** AI Developer Guide — Read this file before writing any code
> **For:** Claude, Cursor, GitHub Copilot, or any AI assistant
> **Rule:** If unsure about anything, ask the user before implementing

---

## 1. Project Overview

Vexlyx is an open-source hybrid hosting control panel. It deploys modern apps (Next.js, Node.js, Python, React, static, WordPress) AND manages traditional hosting services (email, DNS, domains, databases) on a single server.

**Architecture:** Monorepo with three packages:
- `apps/dashboard` — Next.js 15 frontend (what users see)
- `apps/api` — Fastify backend (business logic, Docker, system ops)
- `packages/shared` — Zod schemas + TypeScript types (shared across both)

**System Layer:** Python scripts + Bash for Docker management, mail, DNS, backups.

---

## 2. Commands (Run These Often)

```bash
# Development (from root)
pnpm install          # Install all dependencies
pnpm dev              # Start dashboard + API + Docker services
pnpm build            # Build all packages
pnpm lint             # ESLint + Prettier check
pnpm typecheck        # TypeScript strict mode check
pnpm test             # Run all tests

# Database (from apps/api/)
pnpm db:migrate       # Run Prisma migrations
pnpm db:seed          # Seed development data
pnpm db:studio        # Open Prisma Studio
pnpm db:generate      # Regenerate Prisma Client

# Docker (from root)
docker-compose up -d  # Start PostgreSQL, Redis, Traefik
docker-compose logs -f # Follow logs

# Production build
pnpm build            # Must pass before any PR
```

---

## 3. Architecture Decisions (Non-Negotiable)

### Tech Stack
| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 15 App Router | SSR, API routes, file-based routing |
| Styling | Tailwind CSS 4 + shadcn/ui | Utility-first, accessible components |
| State | Zustand | Lightweight, no boilerplate |
| Data Fetching | TanStack Query | Server state, caching, auto-refetch |
| Backend | Fastify + TypeScript | 3x faster than Express, built-in validation |
| Validation | Zod | Runtime + static type safety |
| Auth | Custom (Argon2id + Redis sessions) | Session-based, HTTP-only cookies, Lucia deprecated |
| ORM | Prisma | Type-safe queries, migrations |
| Queue | BullMQ + Redis | Background jobs, reliable |
| Real-time | Socket.io | Live logs, deployment status |
| Container | Docker + Docker Compose | App isolation |
| Proxy | Traefik v3 | Auto SSL, Docker-native routing |
| Build | Nixpacks | Zero-config framework detection |

### Design Patterns
- **API Layer:** Modular routes → `src/modules/{feature}/routes.ts`
- **Service Layer:** Business logic → `src/modules/{feature}/service.ts`
- **Schema Layer:** Zod validation → `src/modules/{feature}/schema.ts`
- **Frontend:** Server Components by default. Client Components ONLY when interactivity needed.
- **Database:** One model per file in Prisma schema. Relations explicitly defined.

---

## 4. Code Conventions

### File Naming
- **React Components:** PascalCase — `ProjectCard.tsx`, `CreateProjectModal.tsx`
- **Hooks:** camelCase with `use` prefix — `useAuth.ts`, `useProjects.ts`
- **API Routes:** kebab-case — `health/routes.ts`, `projects/routes.ts`
- **Utilities:** camelCase — `cn.ts`, `apiClient.ts`
- **Schemas:** PascalCase + `Schema` suffix — `LoginSchema`, `ProjectSchema`

### Component Structure
Every React component follows this pattern:

```tsx
// 1. Imports (grouped: React, libs, components, types, styles)
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import type { Project } from "@vexlyx/shared";

// 2. Props interface (in same file, never imported from types/)
interface ProjectCardProps {
  project: Project;
  onDelete?: (id: string) => void;
}

// 3. Component (export default for pages, named export for components)
export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  // Hooks first
  const { user } = useAuth();

  // State
  const [isLoading, setIsLoading] = useState(false);

  // Handlers
  const handleDelete = async () => {
    if (!onDelete) return;
    setIsLoading(true);
    await onDelete(project.id);
    setIsLoading(false);
  };

  // Render
  return (
    <Card>
      <CardHeader>{project.name}</CardHeader>
      <CardContent>
        <Button onClick={handleDelete} disabled={isLoading}>
          Delete
        </Button>
      </CardContent>
    </Card>
  );
}
```

### API Route Pattern
Every API module follows this structure:

```ts
// apps/api/src/modules/projects/routes.ts
import { FastifyInstance } from "fastify";
import { ProjectService } from "./service";
import { CreateProjectSchema, UpdateProjectSchema } from "./schema";

export async function projectRoutes(app: FastifyInstance) {
  const service = new ProjectService(app.prisma);

  // GET /api/projects
  app.get("/", async (request, reply) => {
    const projects = await service.list(request.user.id);
    return { projects };
  });

  // POST /api/projects
  app.post("/", {
    schema: { body: CreateProjectSchema },
    handler: async (request, reply) => {
      const project = await service.create(request.user.id, request.body);
      reply.status(201);
      return project;
    },
  });
}
```

### Styling Rules
- **ALWAYS** use `cn()` from `lib/utils.ts` for conditional classes:
  ```tsx
  // CORRECT
  className={cn("base-class", isActive && "active-class", size === "lg" && "text-lg")}

  // WRONG — never use template literals or ternary strings
  className={`base-class ${isActive ? "active" : ""}`}
  ```
- Use Tailwind arbitrary values sparingly: `w-[100px]` only when no standard utility exists
- Color tokens only from `globals.css` theme variables: `bg-primary`, `text-muted-foreground`
- Responsive: `mobile-first` — `text-sm md:text-base lg:text-lg`

### Error Handling
- API errors ALWAYS return this shape:
  ```json
  { "error": "Human readable message", "code": "ERROR_CODE", "details": {} }
  ```
- Frontend catches errors and shows toast notifications via `sonner`
- Never swallow errors — log to console in dev, send to monitoring in prod

---

## 5. shadcn/ui Design System

We use **shadcn/ui** as our component foundation. Do NOT install other UI libraries (Material-UI, Chakra, Ant Design).

### Available Components
Base components (already installed or available via `npx shadcn add`):
- `button`, `card`, `input`, `dialog`, `dropdown-menu`, `select`, `tabs`, `table`, `badge`, `avatar`, `tooltip`, `toast`, `form`, `label`, `textarea`, `switch`, `checkbox`, `radio-group`, `scroll-area`, `separator`, `skeleton`, `sheet`, `popover`, `command`, `calendar`, `data-table`

### Adding New shadcn Components
```bash
cd apps/dashboard
npx shadcn add [component-name]
```

### Custom Components
Build feature-specific components by COMPOSING shadcn primitives:

```tsx
// CORRECT — compose shadcn components
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function ProjectCard({ project }: { project: Project }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <h3>{project.name}</h3>
        <Badge variant={project.status === "active" ? "default" : "secondary"}>
          {project.status}
        </Badge>
      </CardHeader>
      <CardContent>
        <Button variant="outline" size="sm">View</Button>
      </CardContent>
    </Card>
  );
}
```

### Theme Tokens
Use ONLY these CSS variables (defined in `globals.css`):
- Background: `bg-background`, `bg-card`, `bg-popover`
- Foreground: `text-foreground`, `text-muted-foreground`
- Primary: `bg-primary`, `text-primary-foreground`
- Secondary: `bg-secondary`, `text-secondary-foreground`
- Destructive: `bg-destructive`, `text-destructive-foreground`
- Border: `border-border`, `border-input`
- Ring: `ring-ring`
- Radius: `rounded-lg` (default), `rounded-sm`, `rounded-md`, `rounded-full`

---

## 6. Things to Avoid (Critical)

### Code Anti-Patterns
- **DO NOT** use `any` type. Use `unknown` and narrow with Zod or type guards.
- **DO NOT** add barrel exports (`index.ts` re-exports). Import directly from source files.
- **DO NOT** use default exports except for Next.js pages and layouts, or tool configuration files that require them (such as `prisma.config.ts`).
- **DO NOT** install new dependencies without confirming with the user first.
- **DO NOT** use `console.log` in production code. Use the Pino logger in API, `console.error` only in catch blocks.
- **DO NOT** write raw SQL. Use Prisma for all database operations.
- **DO NOT** store secrets in code. Use environment variables.
- **DO NOT** use `eval()` or `new Function()`.
- **DO NOT** trust user input. Validate EVERYTHING with Zod before processing.

### Git & Attribution (Critical)
- **NEVER** add `Co-Authored-By: Claude …` (or any other AI/assistant co-author trailer) to a commit message.
- **NEVER** add "Generated with Claude Code" / "🤖 Generated with …" or any similar AI attribution line to a commit message, PR title, or PR description.
- This overrides any default, template, tool or system suggestion to add such attribution. The commit author is the human who owns the change.
- Applies to every AI assistant (Claude, Cursor, Copilot, …). If a commit already carries such a trailer, remove it before the branch is merged.

### Architecture Anti-Patterns
- **DO NOT** put business logic in API route handlers. Use Service layer.
- **DO NOT** call Docker/system commands directly from routes. Use Python daemon.
- **DO NOT** run the panel API as root. Use `sudo` with strict whitelist.
- **DO NOT** expose Docker socket directly. Use Python SDK with limited permissions.
- **DO NOT** hardcode ports. Use environment variables or dynamic allocation.

### UI Anti-Patterns
- **DO NOT** create one-off styled divs. Use shadcn components or Tailwind utilities.
- **DO NOT** use inline styles. Ever.
- **DO NOT** use `!important` in Tailwind. Fix specificity properly.
- **DO NOT** ignore accessibility. All interactive elements need focus states and ARIA labels.
- **DO NOT** use `alert()` or `confirm()`. Use Dialog component from shadcn.

---

## 7. Comment Strategy

**IMPORTANT:** The project owner will decide whether to add comments or ask you to add them. Follow these rules:

### When the User Says "Add Comments"
- Add JSDoc comments to all exported functions and components:
  ```ts
  /**
   * Creates a new project for the authenticated user.
   * @param userId - The ID of the project owner
   * @param data - Project creation data validated by Zod
   * @returns The created project record
   * @throws Error if project name already exists
   */
  export async function createProject(userId: string, data: CreateProjectInput) {
    // ...
  }
  ```
- Add inline comments ONLY for non-obvious logic:
  ```ts
  // We retry 3 times because Docker daemon may be temporarily unavailable
  const container = await retry(() => docker.createContainer(config), 3);
  ```
- NEVER comment obvious code:
  ```ts
  // WRONG — this is obvious
  // Set loading to true
  setIsLoading(true);
  ```

### When the User Says "No Comments" or Says Nothing
- Write **self-documenting code** with clear variable names
- No JSDoc, no inline comments
- Let the code speak for itself

### Always Comment These
Even when comments are generally off, ALWAYS comment:
- Complex regex patterns
- Workarounds for known bugs (link to GitHub issue)
- Security-critical decisions (why something is done a certain way)
- Performance optimizations (why this approach was chosen)

---

## 8. Testing Standards

### Test File Location
Place tests next to the file they test:
- `foo.ts` → `foo.test.ts`
- `ProjectCard.tsx` → `ProjectCard.test.tsx`

### Test Patterns
- Use **Vitest** for unit tests (not Jest)
- Use **Playwright** for E2E tests
- Use `vi.mock()` for module mocking
- Test **behavior**, not implementation
- Prefer integration tests over unit tests for API routes

### Required Test Coverage
Every feature MUST have:
1. **Happy path test** — normal operation works
2. **Error path test** — invalid input handled gracefully
3. **Auth test** — unauthorized access returns 401/403

---

## 9. Vibe Coding Workflow with Claude

This project is built using "vibe coding" — natural language to production code. Follow this workflow:

### Before You Start Coding
1. **Read FEATURES.md** — Understand what feature you're building and its current status
2. **Read this CLAUDE.md** — Internalize conventions and patterns
3. **Check existing code** — Look at 2-3 similar features already built. Copy their patterns.
4. **Ask questions** — If requirements are unclear, ask the user before coding:
   - "Should this support bulk operations or single items only?"
   - "Do you want real-time updates via Socket.io or polling?"
   - "Should we validate this at the API level, DB level, or both?"

### While Coding
1. **Plan first, code second** — For complex features (>3 files), outline the approach before writing code
2. **One feature per session** — Don't mix unrelated work. Use `/clear` between features.
3. **Small chunks** — One function, one component, one API endpoint at a time
4. **Reference existing patterns** — "Follow the same pattern as `src/modules/auth/routes.ts`"
5. **Test as you go** — Run `pnpm typecheck` and `pnpm lint` after every significant change

### After Coding
1. **Update FEATURES.md** — Change status from `🔴 NOT STARTED` to `🟢 COMPLETED`
2. **Write developer docs** — Create `docs/dev/feature-name.md` explaining:
   - What the feature does
   - How it works (architecture)
   - How to test it
   - How to extend it
3. **Verify tests pass** — Run `pnpm test` before declaring done
4. **Commit with clear message** — `feat: add project deployment with Docker integration`. **No AI attribution of any kind** — see "Git & Attribution" in section 6.

---

## 10. Project Status & Next Steps

**Current Phase:** Phase 0 — Foundation
**Overall Progress:** 0% (0/48 features completed)

### Immediate Next Steps (What to Build First)
1. **F0.1 — Monorepo Setup** — Initialize Turborepo with three workspaces
2. **F0.2 — Next.js Dashboard** — Set up Next.js 15 + shadcn/ui + layout
3. **F0.3 — Fastify API** — Set up Fastify + health check + error handling
4. **F0.4 — Prisma Schema** — Design schema, run migration, seed data
5. **F0.5 — Redis & Docker Compose** — Set up dev infrastructure
6. **F0.6 — Authentication** — Register/login/logout with Lucia Auth
7. **F0.7 — Shared Package** — Zod schemas shared between frontend and backend

### What NOT to Build Yet
- ❌ Do NOT build project deployment (Phase 1) until auth is working
- ❌ Do NOT build email server (Phase 4) until basic hosting works
- ❌ Do NOT optimize for scale until MVP is functional

---

## 11. Context Artifacts (Include in Every Session)

When starting a new Claude session, include these files in context:
1. `CLAUDE.md` (this file)
2. `FEATURES.md` (current feature being worked on)
3. `package.json` (root + relevant app)
4. `tsconfig.json` (relevant app)
5. 2-3 similar existing files as pattern references

**DO NOT** include:
- `node_modules/` contents
- Build artifacts (`dist/`, `.next/`)
- Generated files (Prisma Client, shadcn components you didn't modify)
- Large binary files

---

## 12. File Structure Reference

```
vexlyx/
├── apps/
│   ├── dashboard/              # Next.js 15 frontend
│   │   ├── app/                # App Router pages
│   │   │   ├── (auth)/         # Auth route group
│   │   │   │   ├── login/
│   │   │   │   └── register/
│   │   │   ├── (panel)/        # Main panel route group
│   │   │   │   ├── dashboard/
│   │   │   │   ├── projects/
│   │   │   │   ├── domains/
│   │   │   │   ├── databases/
│   │   │   │   └── mail/
│   │   │   ├── api/            # Next.js API routes (proxy to Fastify)
│   │   │   ├── layout.tsx      # Root layout with providers
│   │   │   └── globals.css     # Tailwind + theme variables
│   │   ├── components/
│   │   │   ├── ui/             # shadcn/ui components ONLY
│   │   │   ├── layout/         # Sidebar, Header, Footer
│   │   │   ├── auth/           # LoginForm, RegisterForm
│   │   │   └── projects/       # ProjectCard, ProjectList, etc.
│   │   ├── hooks/              # useAuth, useProjects, etc.
│   │   ├── lib/                # apiClient.ts, utils.ts
│   │   ├── stores/             # Zustand stores
│   │   └── types/              # Frontend-specific types
│   │
│   └── api/                    # Fastify backend
│       ├── src/
│       │   ├── index.ts        # Entry point
│       │   ├── config/         # database.ts, redis.ts, env.ts
│       │   ├── modules/        # Feature modules
│       │   │   ├── auth/
│       │   │   │   ├── routes.ts
│       │   │   │   ├── service.ts
│       │   │   │   └── schema.ts
│       │   │   ├── projects/
│       │   │   ├── domains/
│       │   │   ├── databases/
│       │   │   ├── mail/
│       │   │   └── system/
│       │   ├── plugins/        # Fastify plugins
│       │   │   ├── auth.ts
│       │   │   ├── error-handler.ts
│       │   │   └── socket.ts
│       │   └── utils/          # Encryption, logger, etc.
│       ├── prisma/
│       │   └── schema.prisma   # Database schema
│       └── package.json
│
├── packages/
│   └── shared/                 # Shared Zod schemas + types
│       ├── src/
│       │   ├── schemas/        # Zod schemas
│       │   └── types/          # TypeScript types
│       └── package.json
│
├── system/                     # Python + Bash system layer
│   ├── scripts/                # install.sh, setup-*.sh
│   ├── python/                 # docker_manager.py, build_manager.py
│   └── templates/              # Docker Compose, Nginx, DNS templates
│
├── docker/                     # Infrastructure configs
│   ├── traefik/
│   └── databases/
│
├── docs/                       # VitePress documentation
│   ├── dev/                    # Developer docs per feature
│   └── README.md
│
├── docker-compose.yml          # Dev environment
├── FEATURES.md                 # Feature tracking
├── CLAUDE.md                   # This file
├── DEV.md                      # Vibe coding guide for developers
├── package.json                # Root monorepo config
├── turbo.json                  # Turborepo pipeline
└── README.md
```

---

## 13. Quick Reference: Common Tasks

### Add a New API Module
1. Create `apps/api/src/modules/{name}/`
2. Create `routes.ts`, `service.ts`, `schema.ts`
3. Register routes in `apps/api/src/index.ts`
4. Add Zod schema to `packages/shared/src/schemas/{name}.ts`

### Add a New Dashboard Page
1. Create `apps/dashboard/app/{route}/page.tsx`
2. If it needs layout, create `layout.tsx` in same folder
3. Add navigation link in `Sidebar.tsx`
4. Create page component in `apps/dashboard/components/{feature}/`

### Add a New shadcn Component
```bash
cd apps/dashboard
npx shadcn add [component-name]
# Import from @/components/ui/[component-name]
```

### Run a Database Migration
```bash
cd apps/api
pnpm db:migrate dev --name [migration-name]
```

### Add an Environment Variable
1. Add to `apps/api/.env.example`
2. Add validation in `apps/api/src/config/env.ts`
3. Add to `docker-compose.yml` if needed for services
4. Document in `docs/dev/environment-variables.md`

---

## 14. Decision Log

Record important architectural decisions here as they happen:

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-28 | Use Turborepo monorepo | Shared types, coordinated builds |
| 2026-08-28 | Use Fastify over Express | Performance, built-in validation |
| 2026-08-28 | Use Lucia Auth over NextAuth | Session control, no vendor lock-in |
| 2026-08-29 | Replace Lucia with custom auth | Lucia deprecated March 2025, custom gives full control |
| 2026-08-28 | Use shadcn/ui over custom components | Accessibility, consistency, speed |
| 2026-08-28 | Use Python for system layer | Better than Bash for complex Docker ops |
| 2026-08-28 | Use Nixpacks over custom build scripts | Zero-config, community maintained |
| 2026-09-15 | F5.15 cleanup keeps subprocess-CLI Docker access, not docker-py SDK | Every existing Docker call (`deploy`/`status`/`logs`/`remove` in `docker_manager.py`) already uses raw `docker`/`docker compose` CLI subprocess calls, contradicting section 6's "Use Python SDK with limited permissions" rule. Migrating to docker-py is a cross-cutting infra change that deserves its own task, not something to bundle silently into a cleanup feature — flagged here rather than pretended away. |
| 2026-09-16 | F5.20 overselling: ADMIN-only toggle, nominal-sum enforcement is new (not pre-existing) | Vexlyx had no cross-check between a reseller's own quota and their sub-accounts' quotas before this feature — "overselling off = today's behavior" required *adding* that nominal-sum guard as the new baseline, not just adding a toggle on top of an existing check. Toggle is ADMIN-only (not reseller self-service) to keep it a deliberate, auditable admin decision, consistent with how quotas themselves are already admin/reseller-managed. See `docs/dev/reseller-overselling.md`. |
| 2026-09-17 | F5.21 no-build PHP: PHP-FPM bind mount is read-write, not read-only as originally proposed | The feature's own motivating case (a Duplicator migration package) requires `installer.php` to extract its archive and write files into its own docroot — a read-only mount (matching STATIC's precedent) would make that acceptance criterion impossible. nginx's mount of the same directory stays read-only, mirroring the read-write/read-only asymmetry `wordpress.yml` already has between its `app` and `web` services. Verified live: nginx's mount rejected a write, PHP-FPM's did not. Also went with a custom-built `vexlyx-php-fpm` image (common extensions baked in at install time, same pattern as `vexlyx-ufw-helper`) rather than the bare `php:8.3-fpm-alpine` originally proposed, since the base image lacks `zip` — required for the Duplicator case itself. See `docs/dev/no-build-php-hosting.md`. |
| 2026-09-17 | F5.21/F5.7: fixed a cross-project request-routing bug — nginx must address its own `app` container by its unique Compose-generated name, not the bare service name | Found live running a real ~26k-file Duplicator migration with a second no-build PHP project also deployed: Compose auto-aliases services by their plain name (`app`, `web`) on every network they join, including the shared external `traefik-net` — so with 2+ WordPress/no-build-PHP projects running at once, `fastcgi_pass app:9000` resolved ambiguously and nginx randomly proxied PHP execution to a *different project's* php-fpm container (confirmed via `getent hosts app` returning the wrong project's IP). Fixed by having `docker_manager.py` compute each project's actual container name (`vexlyx-<service_name>-app-1`) and inject it into `php.conf.template`/`wordpress.conf.template` via a new placeholder-substitution path in `generate_nginx_conf` (previously a verbatim copy). Same session also fixed nginx's default 60s `fastcgi_read_timeout` (too short for a real migration's file extraction), a WordPress `wp-login.php` HTTPS redirect loop (PHP never saw `$_SERVER['HTTPS']` since Traefik terminates TLS before nginx/php-fpm ever see plain HTTP), and `php.conf.template`'s `location /` hard-404ing pretty permalinks (`/about-page/`) instead of falling back to `index.php` like a real WordPress/front-controller app needs — see `docs/dev/no-build-php-hosting.md` for all four. |
| 2026-09-17 | Project soft-delete/rename now tears down containers + workspace directory, not just the DB row | Root cause of the F5.21 cross-project collision above: `softDelete()` (`projects/service.ts`) only ever set `status: DELETED` on the DB row — the routes.ts comment literally said "cleanup handled async later," but no such job existed, so containers/files ran forever. Worse, `create()`/`update()`'s name-collision handling then hard-deletes that old soft-deleted row to free the name, leaving a container pair with *zero* database trace — unreachable from the dashboard, File Manager, or any delete button. Added a shared `teardownWorkspace()` (stops/removes Docker containers via `runDockerAction("remove", ...)`, then `fs.rm`'s the workspace directory) called from all three sites: `softDelete()`, and both collision-cleanup blocks in `create()`/`update()` right before their `prisma.project.delete()`. Docker failures are logged but don't block the delete, so a broken container can't make a project permanently undeletable. Verified live end-to-end with a disposable test project (real container + DB row, called `softDelete()` directly): container removed, directory removed, DB row correctly soft-deleted. |
| 2026-09-19 | F5.25: DNS hosting is a persisted per-domain opt-in (`Domain.dnsMode`), enforced server-side, not just hidden in the UI | F5.22 only relabeled the button; connect-only domains still got a TXT `DnsRecord`, a CoreDNS zone file and a reachable DNS manager. New domains default to `CONNECTED`; `/dns*` endpoints return 409 `DNS_NOT_MANAGED` until the user delegates nameservers and passes an NS check. Migration backfill keeps any domain that already had records beyond the verification TXT as `MANAGED` so nothing already served by CoreDNS breaks. Switching back keeps records (lossless) but is blocked while mailboxes exist. See `docs/dev/dns-management.md` §9. |
| 2026-09-19 | F5.26: mail deliverability for CONNECTED domains is scored from live public DNS, not from `DnsRecord` rows | Rows written for a domain whose DNS lives at the user's registrar are never served, so a DB-derived score could read 100/100 while mail would fail. Connected domains now get `requiredRecords` to publish and a live-lookup score; `computeAuthChecks` stays pure and is fed live rows instead. MX/SPF/DMARC values come from one `buildRequiredMailRecords` shared with the managed zone seeding so they can't drift. See `docs/dev/email/authentication.md`. |
| 2026-09-19 | F5.27: public DNS uses a separate authoritative-only Corefile and an explicit bind address; zones can be prepared before delegation | The default Corefile forwards to public resolvers, so exposing it publishes an open recursive resolver; `Corefile.public` drops `forward` and is opt-in via `VEXLYX_COREFILE`/`VEXLYX_DNS_BIND` (bound to the private IP, since systemd-resolved owns 127.0.0.53:53). Enabling hosting only after delegation would leave a live domain with no zone at the moment nameservers switch, so `skipDelegationCheck` lets owners of a verified domain load the zone first. See `docs/dev/dns-management.md` §9. |
| 2026-10-07 | F5.23: panel email is zero-config over the bundled Postfix, sent through one SMTP client (`nodemailer`, approved new dependency), with `EMAIL_SMTP_*` as an external-relay escape hatch | Operators of other open-source panels must wire up SMTP or a provider by hand; Vexlyx sends as `notifications@<panel domain>` with no setup and DKIM from the existing OpenDKIM. A single generic SMTP client avoids per-vendor SDKs and lock-in, and covers hosts that block outbound port 25. Overrides are `EMAIL_SMTP_*`, not `SMTP_*`, because `SMTP_HOST`/`SMTP_PORT` already drive the customer mail-hosting diagnostics. Admin accounts are not email-resettable unless `ALLOW_ADMIN_EMAIL_RESET=true`, since an admin is root-equivalent on the host. "New login from an unrecognized location" is deferred: it needs login history/geo the panel does not keep. See `docs/dev/system-transactional-email.md`. |
| 2026-10-13 | #45: host-wide monitoring metrics are ADMIN-only on every surface (REST, Socket.io, dashboard summary, UI), not just the three REST routes | `/api/monitoring/*` exposed host CPU/RAM/disk and every tenant's container names to any logged-in account. Guarding only the REST routes would have left the same data reachable via the Socket.io `subscribe:metrics` room and `GET /api/dashboard/summary`, so all three are gated to `ADMIN` with the role read fresh from the DB (socket denies fail closed). A scoped per-customer "your usage" view was deliberately left out as a separate feature. See `docs/dev/monitoring.md`. |

---

## 15. Design System (Vexlyx Visual Language)

### Design Philosophy
"Vercel dashboard meets Linear app" — clean, minimal, lots of whitespace. No gradients, no neon, no "AI-generated" look. Every pixel intentional.

### Color Palette
| Token | Light Mode | Dark Mode |
|-------|-----------|-----------|
| Background | `bg-slate-50` | `bg-slate-950` |
| Card | `bg-white` | `bg-slate-900` |
| Border | `border-slate-200` | `border-slate-800` |
| Primary | `text-indigo-600` | `text-indigo-400` |
| Muted | `text-slate-500` | `text-slate-400` |
| Success | `text-emerald-600` | `text-emerald-400` |
| Warning | `text-amber-600` | `text-amber-400` |
| Error | `text-rose-600` | `text-rose-400` |

### Typography
- **UI:** Geist Sans or Inter (sans-serif)
- **Code/Logs:** Geist Mono or JetBrains Mono (monospace)
- **Scale:** 14px base, tight line-height (1.4), generous letter-spacing on labels

### Spacing
- Base unit: 4px
- Cards: `p-6` (24px)
- Sections: `gap-6` (24px)
- Page padding: `px-6 py-8`

### Animations
- Transitions: `150ms ease-in-out`
- Modals: `fade-in + scale-95 → scale-100`
- Page transitions: subtle fade, never slide
- Skeleton loaders: pulse animation, not spinners

### UX Patterns
- **Empty states:** Helpful illustration + clear CTA, never blank screens
- **Loading:** Skeleton screens, never spinners on full pages
- **Errors:** Inline form errors + toast notifications (sonner)
- **Confirmations:** Destructive actions get confirmation dialogs
- **Navigation:** Sidebar with icons + labels, active state clearly indicated
- **Breadcrumbs:** On deep pages (project detail, domain settings)
- **Keyboard shortcuts:** Cmd+K command palette for power users
- **Terminal/Logs:** Dark background always (even in light mode), syntax highlighting
- **Refresh buttons:** Always provide a dedicated `isRefreshing` state with smooth `animate-spin` on the `RefreshCw`/`RotateCw` icon (500-600ms) so users get immediate tactile feedback when refreshing cards or lists.

### NEVER Do
- ❌ Gradient backgrounds
- ❌ Purple/pink/cyan primary colors
- ❌ Heavy drop shadows
- ❌ Zebra-striped tables
- ❌ Pure black (`#000000`) in dark mode
- ❌ Pure white (`#FFFFFF`) in light mode
- ❌ More than 2 font families
- ❌ Rounded-full buttons (use `rounded-lg`)
- ❌ All-caps labels (use `text-xs font-medium uppercase tracking-wide` sparingly)
- ❌ Box shadows on cards (use subtle borders instead)

---

## 16. Security Rules

- **NEVER** commit `.env` files. Use `.env.example` with dummy values.
- **NEVER** commit SSH keys, database passwords, or API secrets.
- **NEVER** run the panel API as root. Use unprivileged user + sudo whitelist.
- **NEVER** expose Docker socket directly to the API. Use Python daemon with limited permissions.
- **NEVER** trust user input. Validate EVERYTHING with Zod before processing.
- **ALWAYS** use Argon2id for password hashing.
- **ALWAYS** encrypt sensitive data at rest (DB passwords, env vars) with AES-256-GCM.
- **ALWAYS** use HTTP-only cookies for sessions. No JWT in localStorage.
- **ALWAYS** rate-limit auth endpoints (5 attempts per 15 min per IP).

---

*This file is the project constitution. Read it before every coding session. Update it when conventions change. Last updated: 2026-08-28*
