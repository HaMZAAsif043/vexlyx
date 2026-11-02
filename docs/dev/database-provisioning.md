# Database Provisioning (MySQL & PostgreSQL)

## What This Does

Feature **F2.6** implements isolated, on-demand database provisioning for **PostgreSQL 16** and **MySQL 8.0** within Vexlyx. Users can create, manage, connect to, and delete databases and database users directly from the dashboard. Credentials are encrypted at rest with AES-256-GCM, auto-injected into project environment variables, and integrated with **Adminer** for web-based GUI management.

---

## Architecture & Data Flow

```
┌────────────────────────────────────────────────────────┐
│                   Next.js Dashboard                    │
│   • /databases page                                    │
│   • /projects/[id] DatabasePanel                       │
└───────────────────────────┬────────────────────────────┘
                            │ (JSON / HTTP with Auth)
                            ▼
┌────────────────────────────────────────────────────────┐
│                    Fastify Backend                     │
│   • POST /api/databases (create & encrypt)             │
│   • GET  /api/databases (list & format URIs)           │
│   • GET  /api/databases/:id (view decrypted credentials)│
│   • POST /api/databases/:id/test (test connection)     │
│   • DELETE /api/databases/:id (drop & cleanup)         │
└─────────────┬───────────────────────────┬──────────────┘
              │                           │
  (Prisma ORM │ AES-256-GCM)              │ child_process.spawn
              ▼                           ▼
┌───────────────────────────┐   ┌────────────────────────────┐
│      PostgreSQL DB        │   │  database_manager.py       │
│  (stores user, databases, │   │  (Python system daemon)    │
│   and encrypted passwords)│   └──────────────┬─────────────┘
└───────────────────────────┘                  │
                                               │ docker exec
                     ┌─────────────────────────┴─────────────────────────┐
                     ▼                                                   ▼
       ┌───────────────────────────┐                       ┌───────────────────────────┐
       │      vexlyx-postgres      │                       │        vexlyx-mysql       │
       │  (PostgreSQL 16 engine)   │                       │     (MySQL 8.0 engine)    │
       │  • CREATE USER & DB       │                       │  • CREATE DATABASE & USER │
       │  • SCHEMA grants          │                       │  • Scoped GRANT ALL ON db │
       │  • Terminate connections  │                       │  • Drop database & user   │
       └───────────────────────────┘                       └───────────────────────────┘
```

---

## Security Model

1. **User Isolation**:
   - Every database user is generated with a scoped username `u_<dbname>_<hex>` and unique high-entropy 24-character password.
   - User privileges are restricted strictly to their own database (PostgreSQL: `GRANT ALL ON DATABASE` + `SCHEMA public`; MySQL: `GRANT ALL ON \`<dbname>\`.*`).
   - Cross-database access is prohibited by engine-level access control.

2. **Encryption at Rest**:
   - Passwords are encrypted before storing in PostgreSQL with **AES-256-GCM** using `apps/api/src/utils/encryption.ts`.
   - Secret key is derived from `ENCRYPTION_KEY` or `SESSION_SECRET` via SHA-256.

3. **SQL Injection Prevention**:
   - Identifiers (`dbName`, `dbUser`) are strictly validated against `^[a-zA-Z0-9_]{1,63}$`.
   - Passwords in SQL commands are escaped and parameterized.

---

## Connection Strings & URIs

For every provisioned database, Vexlyx generates two types of connection URIs:

1. **Internal Docker URI** (for hosted project containers on `vexlyx-apps`):
   - PostgreSQL: `postgresql://u_app_1234:password@vexlyx-postgres:5432/app_production`
   - MySQL: `mysql://u_app_1234:password@vexlyx-mysql:3306/app_production`

2. **Host-Accessible URI** (for local development, DBeaver, DataGrip, TablePlus):
   - PostgreSQL: `postgresql://u_app_1234:password@localhost:5432/app_production`
   - MySQL: `mysql://u_app_1234:password@localhost:3306/app_production`

3. **Adminer Web GUI** — see [Adminer access](#adminer-access) below. The API only returns an `adminerUrl` for a database when Adminer is available, so the dashboard never shows a broken link.

---

## Adminer access

The databases list response includes `adminer: { enabled, url?, disabledReason? }`, computed from one source of truth (`env.ADMINER_URL`). The dashboard's page-level **Open Adminer** button and every per-database link use it; when `enabled` is false the page shows an **Adminer unavailable** button (the reason is its tooltip) and the per-database links are hidden.

### Development

`ADMINER_URL` defaults to `http://localhost:8088` (the `adminer` service in `docker-compose.yml`), so links work out of the box.

### Production

Adminer is **off by default**. An unset `ADMINER_URL` means no link is ever generated, which is why a fresh install shows *Adminer unavailable*. Production values are validated at API startup: `ADMINER_URL` must be HTTPS and must not point at localhost, otherwise the API refuses to start. An empty value is treated as unset.

To enable it on a server:

```bash
cd /opt/vexlyx
sudo bash system/scripts/enable-adminer.sh
```

The script:

1. generates a basic-auth password (user `admin`, override with `ADMINER_USER`) and prints it **once**;
2. writes `ADMINER_BASIC_AUTH` (an apr1 htpasswd entry, single-quoted so Compose does not interpolate its `$`) and `ADMINER_URL=https://adminer.<VEXLYX_DOMAIN>` to `/etc/vexlyx/vexlyx.env`;
3. starts the `adminer` service (`--profile adminer`) and recreates the API so it picks up `ADMINER_URL`.

Adminer is routed only through Traefik at `adminer.<VEXLYX_DOMAIN>` with a Let's Encrypt certificate and the basic-auth middleware; it has **no published host port**. Users then sign in to Adminer a second time with the database credentials shown in the panel. DNS: `adminer.<VEXLYX_DOMAIN>` must resolve to the server (a wildcard `*.<VEXLYX_DOMAIN>` record covers it).

To turn it off: `sudo bash system/scripts/enable-adminer.sh --disable`. Re-running without `--disable` rotates the basic-auth password.

> Never publish Adminer without access control — it gives direct access to every database. If you add your own routing, keep it behind HTTPS and authentication/IP restrictions.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Panel shows **Adminer unavailable** | `ADMINER_URL` is unset (the production default). Run `enable-adminer.sh`. |
| API crash-loops after setting `ADMINER_URL` | The value is HTTP or localhost; production requires a public HTTPS URL. |
| `adminer.<domain>` returns 401 | Expected without the basic-auth login; use the password printed by the script. |
| `adminer.<domain>` returns 404 / certificate error | DNS does not point at the server yet, or the Adminer container is not running (`docker compose ... --profile adminer ps`). |

## Environment Variable Auto-Injection

When a database is linked to a project with `autoInjectEnv = true`, the following variables are automatically encrypted and inserted into the project's environment variables:

| Variable       | Description             | Example                                             |
| -------------- | ----------------------- | --------------------------------------------------- |
| `DATABASE_URL` | Internal connection URI | `postgresql://u_app:pw@vexlyx-postgres:5432/app_db` |
| `DB_TYPE`      | Database engine type    | `POSTGRESQL` or `MYSQL`                             |
| `DB_HOST`      | Internal Docker host    | `vexlyx-postgres` or `vexlyx-mysql`                 |
| `DB_PORT`      | Port number             | `5432` or `3306`                                    |
| `DB_NAME`      | Database name           | `app_db`                                            |
| `DB_USER`      | Scoped username         | `u_app_9a2f`                                        |
| `DB_PASSWORD`  | Plaintext password      | `••••••••••••••••••••••••`                          |

---

## API Endpoints

### 1. List Databases

```http
GET /api/databases?projectId=cm123&type=POSTGRESQL&search=app&page=1&limit=20
```

### 2. Provision Database

```http
POST /api/databases
Content-Type: application/json

{
  "name": "ecommerce_prod",
  "type": "POSTGRESQL",
  "projectId": "cm123456",
  "autoInjectEnv": true
}
```

### 3. Get Database & Credentials

```http
GET /api/databases/:id
```

### 4. Test Connectivity

```http
POST /api/databases/:id/test
```

### 5. Drop Database & User

```http
DELETE /api/databases/:id
```

Returns `204` only after the engine has confirmed the drop; the record is then deleted and `database.deleted` is audited. The drop statements are idempotent (`DROP … IF EXISTS`), so a database that is already gone counts as success.

If the engine drop genuinely fails (container down, wrong root credentials, SQL error) the API returns `502 DATABASE_DROP_FAILED` with the underlying reason, **keeps the record** and writes **no** audit event (#48). Previously the failure was swallowed, the row was deleted and a deletion was audited even though a live database with data was left behind. Fix the engine problem and retry the delete.

Tests: `apps/api/src/modules/databases/service.test.ts`.

---

## How to Test

Run the automated Python test suite covering validation, PostgreSQL lifecycle, and MySQL lifecycle:

```bash
python tests/test_database_provisioning.py
```

Expected output:

```
=================================================================
Running Vexlyx Database Provisioning Test Suite (F2.6)
=================================================================
Testing identifier validation & SQL injection prevention...
  [PASS] SQL injection patterns and invalid identifiers rejected successfully

Testing PostgreSQL provisioning lifecycle...
  [PASS] Created PostgreSQL database 'test_vex_pg_2184' with owner 'u_test_2184'
  [PASS] Verified active PostgreSQL connection (157.29ms latency)
  [PASS] Dropped database 'test_vex_pg_2184' and cleaned up user 'u_test_2184'

Testing MySQL provisioning lifecycle...
  [PASS] Created MySQL database 'test_vex_my_2186' and user 'u_my_2186' with scoped privileges
  [PASS] Verified active MySQL connection (177.64ms latency)
  [PASS] Dropped MySQL database 'test_vex_my_2186' and removed user 'u_my_2186'

=================================================================
ALL DATABASE PROVISIONING TESTS COMPLETED SUCCESSFULLY!
=================================================================
```

---

## File Structure Reference

```
vexlyx/
├── system/
│   └── python/
│       └── database_manager.py        # System layer DB lifecycle daemon
├── packages/
│   └── shared/
│       └── src/
│           ├── schemas/
│           │   └── databases.ts       # Shared Zod schemas & types
│           └── index.ts
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── config/
│   │   │   │   └── env.ts             # DB engine environment configs
│   │   │   ├── modules/
│   │   │   │   └── databases/
│   │   │   │       ├── schema.ts      # Fastify request schemas
│   │   │   │       ├── service.ts     # Business logic & encryption
│   │   │   │       └── routes.ts      # API routes
│   │   │   └── index.ts               # Registered /api/databases
│   └── dashboard/
│       └── src/
│           ├── app/
│           │   └── (panel)/
│           │       ├── databases/
│           │       │   └── page.tsx   # Standalone /databases management page
│           │       └── projects/
│           │           └── [id]/
│           │               └── page.tsx
│           └── components/
│               └── projects/
│                   └── DatabasePanel.tsx # Embedded project DB panel
├── tests/
│   └── test_database_provisioning.py  # Automated test suite
└── docker-compose.yml                 # MySQL 8.0 & Adminer services
```
