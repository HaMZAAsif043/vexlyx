# API Setup — Developer Guide

## Overview

The Vexlyx API is a Fastify 5 server with TypeScript, Zod validation, and a modular plugin architecture. It runs on `http://localhost:5000` during development and serves all backend logic for the dashboard. What started as a single `health` module has grown to ~30 feature modules — see below.

## Architecture

```
apps/api/src/
├── index.ts                    # Entry point — builds & starts Fastify
├── config/
│   ├── env.ts                  # Zod-validated environment variables (~60 vars)
│   ├── redis.ts                # ioredis client, registered as app.redis
│   └── queue.ts                # BullMQ queue/worker registration, registered as app.queues
├── plugins/
│   ├── auth.ts                 # requireAuth / requireRole / requireRoleOrPermission, session cookie handling
│   ├── prisma.ts                # PrismaClient, registered as app.prisma
│   ├── socket.ts                 # Socket.io server + session auth for realtime rooms
│   └── error-handler.ts        # Global error handler plugin — the { error, code, details } shape below
└── modules/                    # ~30 feature directories, each routes.ts + service.ts + schema.ts:
    aliases/  audit-log/  auth/  backups/  build/  cleanup/  dashboard/  databases/
    deploy/   dockerfile/ domains/ env/    files/  firewall/ git/       health/
    logs/     mail/       mailboxes/ monitoring/ projects/ services/  sftp/
    system/   users/      vacation/  webhooks/  wordpress/
```

### Key Concepts

- **Entry point** (`index.ts`): Creates the Fastify instance, registers plugins & modules, then listens.
- **Config** (`config/`): Environment validation runs on import — fails fast if vars are missing.
- **Plugins** (`plugins/`): Fastify plugins that register hooks, decorators, or error handlers — `app.requireAuth`/`app.requireRole` (see [Authentication](authentication.md)), `app.prisma`, `app.redis`, `app.queues`, and Socket.io rooms (see [Real-time logs](realtime-logs.md)) all come from here.
- **Modules** (`modules/`): Feature modules with `routes.ts`, `service.ts`, `schema.ts` — most also spawn a `system/python/*.py` script for anything that needs to touch Docker, Postfix, Dovecot, or the host firewall (see each feature's own reference page for its script).

---

## Route Registration Pattern

Every module exports an async function that receives a `FastifyInstance`:

```ts
// apps/api/src/modules/{feature}/routes.ts
import type { FastifyInstance } from "fastify";

export async function featureRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return { data: "hello" };
  });

  app.post("/", async (request, reply) => {
    // request.body is typed via schema
    reply.status(201);
    return { created: true };
  });
}
```

Register it in `index.ts`:

```ts
await app.register(featureRoutes, { prefix: "/api/feature" });
```

---

## Error Handling

All errors follow a consistent JSON shape:

```json
{
  "error": "Human readable message",
  "code": "ERROR_CODE",
  "details": {}
}
```

### Error Codes

| Code | Status | When |
|------|--------|------|
| `NOT_FOUND` | 404 | Route doesn't exist |
| `VALIDATION_ERROR` | 400 | Zod or Fastify schema validation fails |
| `REQUEST_ERROR` | 4xx | Client errors (auth, permissions, etc.) |
| `INTERNAL_ERROR` | 500 | Unhandled server errors |

### Zod Validation Errors

When a Zod schema fails, `details.fields` contains per-field errors:

```json
{
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": {
    "fields": {
      "email": ["Invalid email"],
      "password": ["String must contain at least 8 character(s)"]
    }
  }
}
```

---

## Environment Variables

Validated with Zod on startup (`apps/api/src/config/env.ts`) — the server refuses to start with a clear error if any are invalid. Core server config is a small set:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PORT` | number | `5000` | Server port |
| `HOST` | string | `0.0.0.0` | Bind address |
| `NODE_ENV` | enum | `development` | `development`, `production`, `test` |
| `CORS_ORIGIN` | string (URL) | `http://localhost:3000` | Allowed CORS origin |
| `DATABASE_URL` | string (URL) | — required | PostgreSQL connection string |
| `REDIS_URL` | string | `redis://localhost:6379` | Redis connection string |
| `SESSION_SECRET` | string | — required, min 32 chars | Session token signing |

Beyond that, each feature module that needs its own configuration adds a block to the same schema — container names for [service status](service-status.md), backup schedule defaults, mail/webmail ports, the [DNS onboarding](dns-onboarding.md) nameservers, and so on. `env.ts` itself is the up-to-date source of truth; each variable there has an inline comment naming the feature that added it.

### Adding a New Env Var

1. Add to the Zod schema in `apps/api/src/config/env.ts`
2. Add to `apps/api/.env.example` with a safe default
3. Document in this file

---

## Adding a New Module

1. Create the module directory:
   ```
   apps/api/src/modules/{name}/
   ├── routes.ts    # Route handlers
   ├── service.ts   # Business logic
   └── schema.ts    # Zod validation schemas
   ```

2. Write your routes following the pattern above.

3. Register in `index.ts`:
   ```ts
   import { nameRoutes } from "./modules/{name}/routes.js";
   // Inside buildApp():
   await app.register(nameRoutes, { prefix: "/api/{name}" });
   ```

4. If you add shared schemas, put them in `packages/shared/src/schemas/{name}.ts`.

---

## Logging

Uses Pino (built into Fastify). In development, logs are pretty-printed via `pino-pretty`.

```ts
// Use the app logger
app.log.info("Server started");
app.log.error(error, "Something failed");
app.log.debug({ userId }, "Processing request");

// Inside route handlers
request.log.info("Handling request");
```

**Never use `console.log`** — use `app.log` or `request.log` instead.

---

## Running the API

```bash
# Development (with hot reload via tsx watch)
cd apps/api
pnpm dev

# Or from root (starts all apps)
pnpm dev

# Type check
pnpm typecheck

# Build
pnpm build
```

---

## OpenAPI reference

The API registers `plugins/openapi.ts` before every route module. `@fastify/swagger` discovers the
registered routes and publishes an OpenAPI 3.1 document; `@fastify/swagger-ui` serves the interactive
reference at `/documentation/`. The raw specification is available at `/documentation/json` and
`/documentation/yaml`.

The plugin supplies stable operation IDs, resource tags, session-cookie security, and the standard
error envelope to routes that do not declare more specific metadata. Public health, authentication,
and signed-webhook routes omit session-cookie security. When adding or changing an endpoint, add
route-specific parameter, body, success-response, and example schemas wherever generic metadata is
not sufficient.

Run the focused contract test with:

```bash
pnpm --dir apps/api exec vitest run src/plugins/openapi.test.ts
```

## Testing Endpoints

```bash
# Health check
curl http://localhost:5000/api/health

# 404 test
curl http://localhost:5000/nonexistent
```
