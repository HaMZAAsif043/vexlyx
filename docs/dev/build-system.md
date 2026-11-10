# F1.4 — Nixpacks Build Integration

## What This Feature Does

Integrates [Nixpacks](https://nixpacks.com) for zero-configuration application builds. It automatically detects project frameworks and languages from source code (Node.js, Next.js, Python, React, PHP, etc.), builds optimized Docker container images, tracks deployment state in PostgreSQL, and progressively records build logs.

---

## Architecture

```
Dashboard (BuildSettingsPanel.tsx / BuildPanel.tsx / useBuild.ts)
    │
    │  PUT  /api/projects/:id            (installCmd / buildCmd / startCmd / port)
    │  GET  /api/projects/:id/build-plan (what auto-detection would pick)
    │  POST /api/projects/:id/build
    │  GET  /api/projects/:id/deployments
    │  GET  /api/projects/:id/deployments/:deploymentId
    ▼
API (apps/api/src/modules/build/)
    ├── routes.ts   — Fastify route handlers (auth-gated, BullMQ queue registration)
    ├── service.ts  — Business logic, BullMQ job processor, Deployment lifecycle
    └── schema.ts   — TriggerBuildBodySchema, DeploymentListQuerySchema, BuildJobData
         │
         │  BullMQ 'build-queue' (Redis)
         │  Job processor
         │
         │  stdin: JSON payload { command: "plan" | "build", installCmd, ... }
         │  stdout: newline-delimited JSON { log: "..." } / { done: true }
         ▼
    system/python/build_manager.py
         │
         ├── cmd_plan()  — nixpacks plan --format json (framework detection)
         │                + derive_install_cmd() for the install command
         └── cmd_build() — nixpacks build <dir> --name <image>
                           [--install-cmd <cmd>] [--build-cmd <cmd>] [--start-cmd <cmd>]
```

### Data Flow

1. **User clicks "Deploy"** in `BuildPanel.tsx`, or sets a command in `BuildSettingsPanel.tsx` first
2. **Dashboard** calls `POST /api/projects/:id/build` with optional `installCmd` / `buildCmd` overrides
3. **API `buildRoutes`** validates request → calls `BuildService.triggerBuild()`
4. **Service** creates a `Deployment` record with status `QUEUED` and enqueues a job into BullMQ `build-queue`
5. **API returns 202 Accepted** immediately with the `Deployment` record; dashboard starts polling `GET /api/projects/:id/deployments/:deploymentId` every 3s
6. **BullMQ Worker** picks up the job:
   - Updates status to `BUILDING`
   - Spawns `build_manager.py plan` to detect framework and default build command
   - Resolves the install command (see below) and spawns `build_manager.py build` to build the Docker image
   - Progressively appends streamed stdout log lines to `Deployment.buildLogs`
   - On success: marks status as `RUNNING` and records `duration` (seconds)
   - On failure: marks status as `FAILED` and appends error details to `buildLogs`

### Build command overrides (F5.34)

Every command has three possible sources, resolved in this order — first non-null wins:

| Command | 1. This run | 2. Project setting | 3. Auto-detection |
|---------|-------------|--------------------|-------------------|
| install | `POST /build` body `installCmd` | `Project.installCmd` | `derive_install_cmd()` from the lockfile / Python manifest |
| build | `POST /build` body `buildCmd` | `Project.buildCmd` | `nixpacks plan` output |
| start | — | `Project.startCmd` | `nixpacks plan` output |

`derive_install_cmd()` lives in `build_manager.py` and is shared by `cmd_plan` and `cmd_build`, so what the
**Detect** button reports is exactly what a build with an empty field would run. A `null` install command
sends no `--install-cmd` flag at all, which leaves Nixpacks' own provider default in charge — that is the
difference between "auto" and "an empty command".

Dockerfile projects skip all of this: they build with `docker build`, where the image itself declares the
install step.

---

## Key Files

| File | Role |
|------|------|
| [`apps/api/src/modules/build/routes.ts`](../apps/api/src/modules/build/routes.ts) | 3 authenticated Fastify routes, BullMQ queue/worker setup |
| [`apps/api/src/modules/build/service.ts`](../apps/api/src/modules/build/service.ts) | `BuildService` class, BullMQ processor, log streaming |
| [`apps/api/src/modules/build/schema.ts`](../apps/api/src/modules/build/schema.ts) | Request validation schemas and `BuildJobData` interface |
| [`apps/api/src/config/queue.ts`](../apps/api/src/config/queue.ts) | BullMQ infrastructure, helper functions (`createQueue`, `createWorker`) |
| [`system/python/build_manager.py`](../system/python/build_manager.py) | Python system layer: `nixpacks plan` and `nixpacks build` |
| [`packages/shared/src/schemas/projects.ts`](../packages/shared/src/schemas/projects.ts) | `TriggerBuildSchema`, `DeploymentStatusSchema` |
| [`packages/shared/src/types/index.ts`](../packages/shared/src/types/index.ts) | `Deployment`, `DeploymentStatus`, `PaginatedDeployments` types |
| [`apps/dashboard/src/hooks/useBuild.ts`](../apps/dashboard/src/hooks/useBuild.ts) | React hooks: `useTriggerBuild`, `useDeploymentPolling`, `useDeployments` |
| [`apps/dashboard/src/components/projects/BuildPanel.tsx`](../apps/dashboard/src/components/projects/BuildPanel.tsx) | Deployment list, status badges, trigger button, and terminal-styled `<pre>` log viewer |
| [`apps/dashboard/src/components/projects/BuildSettingsPanel.tsx`](../../apps/dashboard/src/components/projects/BuildSettingsPanel.tsx) | Per-project install/build/start/port overrides, **Detect** and **Auto** (clear all) actions |
| [`apps/api/src/modules/build/installCmd.test.ts`](../../apps/api/src/modules/build/installCmd.test.ts) | Resolution order for the install command and the payload handed to `build_manager.py` |
| [`tests/test_build_install_command.py`](../../tests/test_build_install_command.py) | `derive_install_cmd()` heuristics, plan output, and `--install-cmd` forwarding |
| [`apps/dashboard/src/app/(panel)/projects/[id]/page.tsx`](../apps/dashboard/src/app/(panel)/projects/[id]/page.tsx) | Project detail page hosting `<BuildPanel />` |

---

## Database Model

Uses the existing `Deployment` model in `apps/api/prisma/schema.prisma`:

| Column | Type | Description |
|--------|------|-------------|
| `id` | `String` (cuid) | Unique deployment ID |
| `status` | `DeploymentStatus` | `QUEUED` → `BUILDING` → `DEPLOYING` → `RUNNING` / `FAILED` / `CANCELLED` |
| `commitHash` | `String?` | Git commit hash |
| `commitMsg` | `String?` | Git commit message |
| `buildLogs` | `String?` | Concatenated terminal log output |
| `duration` | `Int?` | Total build duration in seconds |
| `projectId` | `String` | Foreign key referencing `Project` |
| `createdAt` | `DateTime` | Timestamp when build was queued |
| `updatedAt` | `DateTime` | Timestamp of last status/log update |

The stored commands (F5.34) live on `Project`, not on `Deployment`, so every later deploy reuses them
until the user clears them. Each is nullable, and `null` always means "auto-detect". F5.34 added
`installCmd`; the other three already existed but had no panel to set them.

| Column | Type | Description |
|--------|------|-------------|
| `installCmd` | `String?` | `nixpacks build --install-cmd` override |
| `buildCmd` | `String?` | `nixpacks build --build-cmd` override |
| `startCmd` | `String?` | `nixpacks build --start-cmd` override |
| `port` | `Int?` | Container port, when it should not follow detection or `EXPOSE` |

---

## Environment Variables

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `NIXPACKS_IMAGE_PREFIX` | `vexlyx` | Prefix for Docker image names (e.g. `vexlyx-<projectId>`) |
| `PROJECTS_DIR` | `./workspaces/projects` | Root directory where cloned repos reside |

---

## API Reference

### `POST /api/projects/:id/build`
Triggers a new build for the project.

**Request Body (optional):**
```json
{
  "installCmd": "npm ci --frozen-lockfile",
  "buildCmd": "npm run build:custom"
}
```
Each field applies to this run only and falls back to the project's stored value, then to
auto-detection. The project-detail **Deploy** tab writes the stored values with
`PUT /api/projects/:id`.

**Response (`202 Accepted`):**
```json
{
  "id": "cm9xyz...",
  "status": "QUEUED",
  "commitHash": null,
  "commitMsg": null,
  "buildLogs": null,
  "duration": null,
  "projectId": "cm9abc...",
  "createdAt": "2026-08-30T01:30:00.000Z",
  "updatedAt": "2026-08-30T01:30:00.000Z"
}
```

### `GET /api/projects/:id/deployments`
Lists deployments for a project (ordered latest first).

**Query Params:**
- `page` (default: 1)
- `limit` (default: 10, max: 50)

**Response:**
```json
{
  "deployments": [...],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 3,
    "totalPages": 1
  }
}
```

### `GET /api/projects/:id/deployments/:deploymentId`
Fetches a single deployment (used for log and status polling).

**Response:** Single `Deployment` object.

### `GET /api/projects/:id/build-plan`
Runs `nixpacks plan` over the project's current source without building anything, so the dashboard can
show what auto-detection would pick next to the values the user overrode. Detection itself stays in
`build_manager.py` — this route only shuttles its answer.

**Response (`200`):**
```json
{
  "framework": "nextjs",
  "detectedType": "NEXTJS",
  "installCmd": "pnpm install",
  "buildCmd": "pnpm run build",
  "startCmd": "pnpm start"
}
```

**Errors:** `403` for another user's project, `404 PROJECT_NOT_FOUND`, `400 PROJECT_NOT_CLONED` when there
is no source on disk to analyse yet. A `null` field means Nixpacks proposed nothing for it, so a blank
override leaves the choice with Nixpacks' own default.

---

## How to Test

### 1. Nixpacks CLI installation check
Ensure `nixpacks` is installed on your machine or host:
```bash
nixpacks --version
```
If not installed:
```bash
# Linux/macOS
curl -sSL https://nixpacks.com/install.sh | sh
# Windows (via Scoop or Cargo)
scoop install nixpacks
# or
cargo install nixpacks
```

### 2. Triggering a build via UI
1. Run `pnpm dev`
2. Open `http://localhost:3000/projects/<PROJECT_ID>`
3. Ensure repository is connected in Git settings
4. In the **Deployments** panel, click **Deploy**
5. Watch the deployment transition from `QUEUED` → `BUILDING` → `RUNNING` (or `FAILED`)
6. Click the chevron button to expand and view the build logs

### 3. API build test with cURL
```bash
# Trigger build
curl -X POST http://localhost:5000/api/projects/<PROJECT_ID>/build \
  -H "Content-Type: application/json" \
  -d '{"buildCmd": "npm run build"}' \
  --cookie "session=<YOUR_SESSION>"

# Poll deployment logs
curl http://localhost:5000/api/projects/<PROJECT_ID>/deployments/<DEPLOYMENT_ID> \
  --cookie "session=<YOUR_SESSION>"

# Ask what auto-detection would pick (F5.34)
curl http://localhost:5000/api/projects/<PROJECT_ID>/build-plan \
  --cookie "session=<YOUR_SESSION>"
```

### 4. Build settings panel (F5.34)
1. Open `http://localhost:3000/projects/<PROJECT_ID>` → **Deploy** tab, above the deployment list
2. Click **Detect** — the placeholder in each field shows what `nixpacks plan` derived
3. Type an install command (e.g. `pnpm install --frozen-lockfile`) and click **Save**: the badge flips to
   `Custom` and the Overview tab shows the same value
4. Click **Save & Deploy** — the build log opens with `[vexlyx] Install command: pnpm install --frozen-lockfile`
5. Click **Auto** — every field returns to blank, the badges return to `Auto`, and the next build logs no
   install command because Nixpacks decides again

### 5. Automated coverage
```bash
python tests/test_build_install_command.py    # lockfile heuristics, plan output, --install-cmd forwarding
npx vitest run src/modules/build/installCmd.test.ts                   # apps/api — resolution order + payload
npx vitest run src/components/projects/BuildSettingsPanel.test.tsx    # apps/dashboard — the panel
```

---

## How to Extend

### Add Real-Time Log Streaming via Socket.io (F1.6)
In F1.6:
1. Initialize Socket.io plugin in `apps/api/src/plugins/socket.ts`
2. In `createBuildProcessor`, emit Socket.io events (`deployment:log`, `deployment:status`) alongside DB updates
3. In `BuildPanel.tsx` or `LogViewer.tsx`, subscribe to the project room via Socket.io client

### Docker Deployment Engine Integration (F1.5)
Once the image is built with Nixpacks, F1.5 will read the generated image name (`vexlyx-<projectId>`) and run it with Docker Compose / Traefik routing.
