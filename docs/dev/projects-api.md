# Projects API

## What it does

The Projects API provides full CRUD (Create, Read, Update, Delete) over hosting projects. Every project belongs to one user, and all endpoints are protected by session-based authentication. Deletion is soft — projects are marked `DELETED` with a timestamp rather than removed from the database, enabling async resource cleanup in later phases.

---

## Architecture

```
Request
  └─▶ routes.ts          ← Fastify route handlers (thin, auth-guarded)
        └─▶ service.ts   ← Business logic, ownership checks, DB queries
              └─▶ Prisma ← PostgreSQL via @prisma/client
```

All Zod schemas live in `packages/shared/src/schemas/projects.ts` and are shared between the API and the future dashboard frontend.

### Key files

| File | Role |
|------|------|
| [`routes.ts`](../../apps/api/src/modules/projects/routes.ts) | 5 REST endpoints, all behind `app.requireAuth` |
| [`service.ts`](../../apps/api/src/modules/projects/service.ts) | `ProjectService` class — all business logic |
| [`schema.ts`](../../apps/api/src/modules/projects/schema.ts) | Re-exports Zod schemas from `@vexlyx/shared` |
| [`packages/shared/src/schemas/projects.ts`](../../packages/shared/src/schemas/projects.ts) | Zod definitions for create, update, list query |
| [`packages/shared/src/types/index.ts`](../../packages/shared/src/types/index.ts) | `Project`, `ProjectType`, `ProjectStatus`, `PaginatedProjects` |

---

## Endpoints

All endpoints require a valid session cookie (`vexlyx_session`).

### `GET /api/projects`

Lists the authenticated user's projects. Supports filtering and offset pagination.

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number (1-indexed) |
| `limit` | number | `20` | Items per page (max 100) |
| `type` | `ProjectType` | — | Filter by project type |
| `status` | `ProjectStatus` | — | Filter by status (DELETED excluded by default) |
| `search` | string | — | Case-insensitive name search |

**Response `200`:**
```json
{
  "projects": [ { ...Project } ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

---

### `POST /api/projects`

Creates a new project. Project names are URL-safe (lowercase, alphanumeric, hyphens) and unique per user.

Optional Git URLs follow the same [public-host and protocol policy](git-integration.md) as repository connection. This also applies to updates. Changing or clearing a URL clears the project's GitHub App linkage; omitting it or keeping it unchanged preserves the linkage.

**Request body:**
```json
{
  "name": "my-app",
  "type": "NODEJS",
  "gitUrl": "https://github.com/user/repo",
  "branch": "main",
  "buildCmd": "npm run build",
  "startCmd": "node dist/index.js",
  "port": 3000
}
```

**Response `201`:** The created `Project` object.

**Errors:**
- `409 PROJECT_NAME_EXISTS` — user already has a project with that name

---

### `GET /api/projects/:id`

Returns a single project. Returns `404` if not found or soft-deleted. Returns `403` if the project belongs to another user.

---

### `PUT /api/projects/:id`

Partial update — only send fields you want to change. Project `type` and `status` cannot be changed via this endpoint (type is immutable; status is managed by the deployment engine).

**Request body** (all optional):
```json
{
  "name": "new-name",
  "gitUrl": "https://github.com/user/new-repo",
  "branch": "develop",
  "buildCmd": "pnpm build",
  "startCmd": "node server.js",
  "port": 8080
}
```

**Errors:**
- `409 PROJECT_NAME_EXISTS` — new name conflicts with another project

---

### `DELETE /api/projects/:id`

Soft-deletes the project: sets `status = DELETED` and stamps `deletedAt`. Returns `204 No Content`.

The project remains in the database for audit purposes and async cleanup (Docker container teardown, domain detachment) handled in Phase 1.5+.

---

## Design Decisions

### Soft delete with dual-field guard

Projects are marked with both `status = DELETED` **and** `deletedAt = timestamp`. The `getById` method checks `deletedAt !== null` rather than status, making it robust against any future status transitions.

### Name validation

Project names follow hosting-panel conventions: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. This ensures names can safely become subdomains and Docker container names.

### Ownership enforced in service, not route

All ownership checks (`userId === project.userId`) live in `ProjectService.getById()`, which is called at the start of every write operation. This prevents ownership bypass via any future code path.

### `deletedAt` excluded from public responses

The `PROJECT_SELECT` constant in the service explicitly omits `deletedAt`. The field is an internal implementation detail and should never appear in API responses.

### Status on create

New projects are created with `status = ACTIVE`. When the build engine (F1.4) is introduced, creation will set `CREATING` and transition to `ACTIVE` once the first build succeeds.

---

## How to test

### With curl

```bash
# Set your session cookie after login
COOKIE="vexlyx_session=<your-session-id>"

# Create
curl -X POST http://localhost:5000/api/projects \
  -H "Content-Type: application/json" \
  -b "$COOKIE" \
  -d '{"name":"my-app","type":"NODEJS","branch":"main"}'

# List
curl http://localhost:5000/api/projects -b "$COOKIE"

# Get by ID
curl http://localhost:5000/api/projects/<id> -b "$COOKIE"

# Update
curl -X PUT http://localhost:5000/api/projects/<id> \
  -H "Content-Type: application/json" \
  -b "$COOKIE" \
  -d '{"name":"renamed-app"}'

# Delete
curl -X DELETE http://localhost:5000/api/projects/<id> -b "$COOKIE"
# Expect: 204 No Content
```

---

## How to extend

### Add a new filterable field

1. Add the query param to `ProjectListQuerySchema` in `packages/shared/src/schemas/projects.ts`
2. Add it to the `where` clause in `ProjectService.list()`

### Add a new updatable field

1. Add it to `UpdateProjectSchema` in `packages/shared/src/schemas/projects.ts`
2. Add a conditional spread in the `data` object inside `ProjectService.update()`

### Trigger async cleanup on delete

In `ProjectService.softDelete()`, after the Prisma update, enqueue a BullMQ job:
```ts
await app.queue.add("cleanup:project", { projectId });
```
The queue plugin is already registered (`queuePlugin_` in `index.ts`).
