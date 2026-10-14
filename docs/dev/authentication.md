# Authentication System

> **Feature:** F0.6 — Authentication System  
> **Status:** 🟢 COMPLETED  
> **Date:** 2026-08-29

## What It Does

Complete session-based authentication for Vexlyx. Users can register (email/password), log in, log out, and access protected panel pages. Passwords are hashed with Argon2id. Sessions are stored in Redis for fast lookup and PostgreSQL for audit/admin invalidation. HTTP-only cookies prevent XSS. Rate limiting protects against brute-force attacks.

## Architecture

### Auth Flow

```
Register/Login → Argon2id verify → Create session (Redis + DB) → Set HTTP-only cookie
    ↓
Every request → Read cookie → Lookup session in Redis → Populate request.userId
    ↓
Protected routes → requireAuth preHandler → 401 if no session
    ↓
Logout → Delete session (Redis + DB) → Clear cookie
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Custom auth over Lucia** | Lucia Auth deprecated March 2025. Built our own following Lucia's patterns. |
| **Argon2id** | OWASP-recommended, resistant to side-channel and GPU attacks |
| **Decoy hash on unknown email** | `AuthService.login` runs `argon2.verify` against a process-wide decoy argon2id hash (same parameters as real hashes, random discarded plaintext) when the email is not registered, so unknown-email and wrong-password failures cost the same and return the identical `401 INVALID_CREDENTIALS` body. The decoy is hashed once at startup (`prepareLoginDecoy()`, awaited when the auth routes register) so even the first failed login after a restart does the same work; concurrent callers share one pending hash and a failed hash is retried rather than cached. Without it, response time reveals which emails exist (#44). |
| **Redis + PostgreSQL dual storage** | Redis for speed (every-request lookup), PostgreSQL for audit trail and admin session management |
| **HTTP-only cookies** | Prevents XSS from reading session tokens. No JWT in localStorage. |
| **SameSite=Lax** | CSRF protection without dedicated token mechanism |
| **Auto-promote first user** | First registered user becomes ADMIN. Production uses `ALLOW_REGISTRATION=false` |
| **Scoped rate limiting** | Only auth endpoints (5/15min/IP), not global, so other APIs aren't affected |

### File Structure

```
apps/api/src/
├── config/
│   └── env.ts                    # SESSION_SECRET, ALLOW_REGISTRATION
├── modules/auth/
│   ├── schema.ts                 # Zod: RegisterSchema, LoginSchema
│   ├── service.ts                # AuthService: register, login, getCurrentUser
│   └── routes.ts                 # POST register/login/logout, GET me
├── plugins/
│   └── auth.ts                   # Session plugin + createSession/destroySession
└── index.ts                      # Registers auth plugin + rate-limited routes

apps/dashboard/src/
├── app/(auth)/
│   ├── layout.tsx                # Centered card layout (no sidebar)
│   ├── login/page.tsx            # Login page
│   └── register/page.tsx         # Register page
├── app/(panel)/
│   └── layout.tsx                # Auth guard (validates session server-side)
├── components/auth/
│   ├── LoginForm.tsx             # Email + password form
│   └── RegisterForm.tsx          # Name + email + password + confirm form
├── hooks/
│   └── useAuth.ts                # Auth state + login/register/logout
└── lib/
    └── api.ts                    # fetchAPI with credentials + error handling
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | No | Create user, start session |
| `POST` | `/api/auth/login` | No | Validate credentials, start session |
| `POST` | `/api/auth/logout` | No | Destroy session, clear cookie |
| `GET` | `/api/auth/me` | Yes | Return current user |

### Rate Limiting

Auth endpoints are rate-limited to **5 requests per 15 minutes per IP**. Exceeding returns `429 Too Many Requests`.

### Socket.io connections follow the session (#64)

A Socket.io connection is authenticated once, at the handshake (`plugins/socket.ts`). It is therefore tied to the session that opened it and ended with it, otherwise rooms would keep streaming logs after logout and a connection kept open across a logout → login-as-someone-else in the same tab would keep acting as the previous user.

| Event | What happens to live sockets |
|-------|------------------------------|
| `POST /api/auth/logout` (`destroySession`) | Sockets opened with that session are disconnected immediately |
| Password change / reset (`destroyUserSessions`) | Sockets of every destroyed session are disconnected; the caller's current session is spared |
| Admin/reseller deletes a user (`UserService.delete`) | All of that user's sockets are disconnected |
| Session expires silently (24h TTL), or its user no longer exists | Disconnected by the once-a-minute sweep (`startSessionSweep` in `plugins/socket-session.ts`); a Redis/DB error skips that pass rather than mass-disconnecting users. Passes never overlap: while one is still pending (e.g. during a Redis outage) later ticks are skipped, so at most one unfinished pass exists |

Implementation: every socket joins `session:<id>` and `user:<id>` rooms on connect, so the hooks above target exactly the affected sockets with `io.in(room).disconnectSockets(true)`; `socket.data.sessionId` is kept next to `socket.data.userId` for the sweep.

Client (`apps/dashboard/src/hooks/useSocket.ts`): `logout()` calls `disconnectSocket()`, and login / 2FA confirmation / registration call `reconnectSocket()`. This is needed because a socket the server closed does **not** reconnect on its own, and the shared singleton must not carry one account's identity into the next login.

Tests: `apps/api/src/plugins/socket-session.test.ts`, `auth-sockets.test.ts`, `apps/api/src/modules/users/delete-sockets.test.ts`.

**Not covered:** a role *demotion* does not disconnect already-joined sockets (only new subscriptions are re-authorized, see #65); and the dashboard has no component-test setup yet (#54), so the client change is covered by typecheck/lint only.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_SECRET` | Yes | — | 32+ char secret for session signing |
| `ALLOW_REGISTRATION` | No | `true` | Enable/disable public registration |

## How to Test

```bash
# 1. Start Docker services
docker-compose up -d

# 2. Run migration (already applied)
cd apps/api && pnpm db:migrate

# 3. Start dev servers
pnpm dev

# 4. Test register
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","password":"password123","confirmPassword":"password123"}'

# 5. Test login (use -c to save cookies)
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}' \
  -c cookies.txt

# 6. Test me (use -b to send cookies)
curl http://localhost:5000/api/auth/me -b cookies.txt

# 7. Test logout
curl -X POST http://localhost:5000/api/auth/logout -b cookies.txt

# 8. Verify session destroyed
curl http://localhost:5000/api/auth/me -b cookies.txt
# Should return 401

# 9. Visit http://localhost:3000/dashboard without auth
# Should redirect to /login

# 10. Check Redis sessions
docker exec -it vexlyx-redis redis-cli keys "session:*"
```

### Login timing (account enumeration, #44)

Automated: `pnpm --filter @vexlyx/api test` runs `apps/api/src/modules/auth/service.test.ts`, which asserts an unknown email still triggers exactly one argon2 verify against an argon2id decoy with the same cost parameters as a real hash, returns an error identical to the wrong-password case, and computes the decoy only once per process.

Manual spot check: time several `POST /api/auth/login` calls for a registered email with a wrong password and for an unregistered email. Both should take roughly the same time (an argon2 verify, ~100 ms+), rather than the unknown email returning near-instantly.

Not covered by this change: `POST /api/auth/register` still answers `409 EMAIL_EXISTS` for a registered email, which is a separate, explicit enumeration vector.

## How to Extend

### Adding OAuth providers
1. Create `apps/api/src/modules/auth/oauth.ts`
2. Add OAuth routes (e.g., `GET /api/auth/github`, `GET /api/auth/github/callback`)
3. Use the same `createSession()` helper after OAuth verification

### Adding password reset
1. Create `POST /api/auth/forgot-password` — generates reset token, sends email
2. Create `POST /api/auth/reset-password` — validates token, updates password
3. Store tokens in Redis with short TTL (15 minutes)

### Admin session management
Query PostgreSQL `sessions` table to see all active sessions, revoke by deleting from both DB and Redis.

### Disabling registration in production
Set `ALLOW_REGISTRATION=false` in `.env`. Admin creates users manually via a future admin API.
