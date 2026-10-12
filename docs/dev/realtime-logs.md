# F1.6 — Real-Time Logs

## What This Feature Does

F1.6 adds a Socket.io–based real-time log streaming layer to Vexlyx. Two log streams are supported:

1. **Build logs** — emitted line-by-line as `nixpacks build` runs inside the BullMQ worker. Any subscribed frontend tab receives each line instantly without polling.
2. **Runtime logs** — streamed from a live `docker logs --follow` subprocess when the "Runtime Logs" panel is open in the dashboard.

---

## Architecture

```
Browser (Socket.io client)
        │
        │  WebSocket (cookie auth)
        ▼
Fastify HTTP server
        │
        ├── plugins/socket.ts       ← Socket.io server + session auth
        │
        ├── modules/logs/
        │   ├── service.ts          ← replay, streaming, event handlers
        │   └── routes.ts           ← wires handlers into Fastify
        │
        └── modules/build/service.ts
                └── appendLog()     ← emits log:build after each DB write
```

### Socket.io Rooms

| Room | Who joins | Events received |
|---|---|---|
| `deployment:{id}` | Client via `subscribe:build` | `log:history` (on join), `log:build` (live) |
| `container:{projectId}` | Client via `subscribe:runtime` | `log:runtime`, `log:runtime:error` |

### Authentication

Every Socket.io connection is authenticated in the `io.use()` middleware inside `plugins/socket.ts`. The session cookie (`vexlyx_session`) is parsed from the handshake headers and looked up in Redis — identical to the REST auth flow in `plugins/auth.ts`. Unauthenticated connections are rejected immediately.

The configured `CORS_ORIGIN` is the only accepted browser origin in production. Development accepts any syntactically valid HTTP(S) origin so local dashboard ports and loopback variants continue to work. The policy is enforced for both polling and WebSocket handshakes. Requests without an `Origin` header are allowed for non-browser clients and WebSocket tooling, but this does not bypass authentication: they must still provide a valid session ID backed by Redis.

---

## Key Files

| File | Role |
|---|---|
| [`apps/api/src/plugins/socket.ts`](file:///d:/learing/Vexlyx/apps/api/src/plugins/socket.ts) | Fastify plugin, Socket.io server, session auth, `getIO()` helper |
| [`apps/api/src/modules/logs/service.ts`](file:///d:/learing/Vexlyx/apps/api/src/modules/logs/service.ts) | Build log replay, runtime log streaming, socket event handlers |
| [`apps/api/src/modules/logs/routes.ts`](file:///d:/learing/Vexlyx/apps/api/src/modules/logs/routes.ts) | Wires `registerSocketHandlers` into Fastify |
| [`apps/api/src/modules/build/service.ts`](file:///d:/learing/Vexlyx/apps/api/src/modules/build/service.ts) | Modified `appendLog` to emit `log:build` after each DB write |
| [`apps/dashboard/src/hooks/useSocket.ts`](file:///d:/learing/Vexlyx/apps/dashboard/src/hooks/useSocket.ts) | Singleton `socket.io-client`, ref-counted lifecycle |
| [`apps/dashboard/src/hooks/useLogs.ts`](file:///d:/learing/Vexlyx/apps/dashboard/src/hooks/useLogs.ts) | `useBuildLogs()` and `useRuntimeLogs()` hooks |
| [`apps/dashboard/src/components/projects/LogViewer.tsx`](file:///d:/learing/Vexlyx/apps/dashboard/src/components/projects/LogViewer.tsx) | Shared terminal-style log viewer component |

---

## How to Test

### 1. Build log streaming
1. Open a project page in the dashboard
2. Click **Deploy**
3. Expand the new deployment row
4. Watch build log lines appear in real-time as nixpacks runs — no polling, no refresh

### 2. Build log replay
1. Navigate away from a completed deployment's project page
2. Navigate back and expand that deployment
3. Full build log should appear immediately (replayed from DB on room join)

### 3. Runtime logs
1. A container must be running (`containerStatus: running`)
2. Click **Runtime Logs** in the Live Container card
3. New container output appears live — auto-scrolls to bottom
4. Scroll up manually — a "scroll paused" banner appears
5. Click the banner (or the ▶ button) — auto-scroll resumes

### 4. stderr filter
1. Click the **Filter** (funnel) icon in any LogViewer header
2. Only lines with `[vexlyx:error]` / stderr stream are shown
3. Click again to restore all streams

### 5. Auth guard
- Open browser DevTools → Network tab
- Confirm the Socket.io WebSocket connection sends the `vexlyx_session` cookie
- A request without the cookie will be rejected by the server with an `UNAUTHORIZED` error event

---

## How to Extend

### Add a new log source
1. Define a new Socket.io room name (e.g., `nginx:{projectId}`)
2. Add `subscribe:nginx` / `unsubscribe:nginx` handlers in `logs/service.ts`
3. Add the corresponding `useNginxLogs()` hook in `useLogs.ts` following the `useRuntimeLogs` pattern
4. Render with `<LogViewer lines={...} title="Nginx Logs" isLive isConnected={...} />`

### Change the line cap
The 1000-line cap is defined as `MAX_LINES = 1000` at the top of `hooks/useLogs.ts`. Change it there — no API changes needed.

### Make LogViewer taller/shorter
Pass a different `maxHeightClass` prop — e.g., `maxHeightClass="max-h-[60vh]"`.

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Styled `<pre>` instead of xterm.js | Logs are read-only; xterm.js is built for interactive shells and adds ~300KB. The pre approach is consistent with existing Vexlyx UI patterns. |
| Frontend-only 1000-line cap | DB keeps the full log for audit purposes. Truncating at write time is destructive. The client caps for render performance. |
| `docker logs --follow` via Python daemon | Consistent with existing `runDockerAction` / `runDockerStatus` architecture. Avoids direct Docker socket exposure (CLAUDE.md §6). |
| Singleton socket client | One WebSocket connection for the entire app lifetime, ref-counted. Prevents duplicate connections when multiple log panels are open simultaneously. |
| Room-per-deployment model | Isolates events so a user watching deployment A never receives events from deployment B. Ownership is verified server-side before join is allowed. |
