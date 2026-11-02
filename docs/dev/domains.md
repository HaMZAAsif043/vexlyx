# Custom Domain Management (F3.1)

> **Feature:** F3.1 — Custom Domain Management  
> **Status:** 🟢 COMPLETED  
> **Package:** `@vexlyx/api`, `@vexlyx/dashboard`, `@vexlyx/shared`  
> **Prisma Models:** `Domain`, `DnsRecord`, `Project`

---

## 1. Overview

Existing domains can be assigned, moved, or unassigned with `PATCH /api/domains/:id`
and `{ "projectId": "project-id" }` (or `null` to unassign). The authenticated user
must own both the domain and the target project, which must not be soft deleted.
The update preserves domain IDs, verification, DNS records, SSL certificates, and
mail data. Routing is refreshed for active assignments and removed on unassign;
certificate files are retained. Changes produce a `domain.updated` audit entry.

The Domains page provides **Assign to project / Change project**, including a
**None (Unassigned)** option. The project Domains tab offers to attach an existing
owned hostname after the add flow detects a duplicate, and explicitly confirms
moves from another project. Subdomains keep their own independent assignments.

Regression coverage: `apps/api/src/modules/domains/service.test.ts`.

Custom Domain Management allows users to attach custom fully-qualified domain names (FQDNs) to their deployed projects, verify domain ownership through DNS TXT record challenges, and automatically configure Traefik v3 HTTP routing using zero-downtime dynamic file provider definitions.

When a domain is verified, Vexlyx generates a dynamic router configuration in `docker/traefik/dynamic/domain-{domainId}.yml` routing all incoming web traffic matching `Host(...)` to the project's container on `vexlyx-apps`. When a domain is deleted, the dynamic configuration file is removed immediately with zero downtime or container restarts.

The API never restarts or signals the shared `vexlyx-traefik` container: restarting it would drop TLS for every site on the server. Route files are written to a `.tmp` file in the same directory and renamed into place, so Traefik's file provider (`watch: true`) only ever sees a complete file, and Let's Encrypt issuance starts when the router with `tls.certResolver` appears. On Docker Desktop for Windows the bind-mount watcher can miss changes (see `docs/dev/email/webmail.md`); that is a development-only caveat, and a manual `docker restart vexlyx-traefik` there is not needed on Linux servers.

---

## 2. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Next.js Dashboard UI                     │
│  - /domains (Global domain overview & project assignment)   │
│  - /projects/[id] (Project detail DomainPanel)              │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / JSON
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Fastify API Server                      │
│  - POST   /api/domains              (Register domain)       │
│  - GET    /api/domains              (List user domains)     │
│  - GET    /api/domains/:id          (Get domain details)    │
│  - POST   /api/domains/:id/verify   (Resolve DNS & verify)  │
│  - DELETE /api/domains/:id          (Unlink & cleanup)      │
└───────────────┬──────────────────────────────┬──────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────────┐ ┌───────────────────────────┐
│     PostgreSQL (Prisma)       │ │  Traefik v3 Dynamic File  │
│  - model Domain               │ │  docker/traefik/dynamic/  │
│    * hostname (unique)        │ │  domain-{domainId}.yml    │
│    * status (PENDING/ACTIVE)  │ └─────────────┬─────────────┘
│    * verificationToken        │               │ Hot-reloaded
│    * projectId (relation)     │               ▼
│  - model DnsRecord (TXT)      │ ┌───────────────────────────┐
└───────────────────────────────┘ │ Traefik v3 Reverse Proxy  │
                                  │ routes Host(domain) to    │
                                  │ {service_name}@docker     │
                                  └───────────────────────────┘
```

### Key Workflow:

1. **Domain Registration (`POST /api/domains`)**:
   - Hostname validated against RFC 1123 FQDN syntax (lowercase, no protocols, valid labels).
   - Generates a cryptographic verification token: `vexlyx-verify-<32-hex-chars>`.
   - Stores `Domain` in database with status `PENDING` and inserts a matching `DnsRecord` TXT challenge.
   - Returns DNS instructions:
     - **Type**: `TXT`
     - **Host**: `_vexlyx-challenge.<hostname>`
     - **Value**: `vexlyx-verification=<token>`
     - Plus a `routingRecord` (an `A` record: `<hostname>` → the server's public IP, from F5.9's `PUBLIC_IP`) — TXT verification only proves ownership, it doesn't route traffic. Found live: a domain that verified successfully still showed nothing when visited, because nothing told the admin an A record was also needed. `DomainPanel.tsx`'s DNS Instructions modal now shows both.

2. **DNS Ownership Verification (`POST /api/domains/:id/verify`)**:
   - Queries `_vexlyx-challenge.<hostname>` and `<hostname>` directly against a few public resolvers (Cloudflare/Google/Quad9 — `new dns.Resolver()` + `setServers()`, not the server's own configured resolver) — found live that a premature "Verify" click could get the server's local/cloud-provider resolver to negative-cache a lookup for up to the zone's SOA TTL (observed: 1 hour on an AWS VPC resolver), making a genuinely-published record look missing long after it actually propagated. Any one public resolver seeing the record is enough.
   - If matching token is detected:
     - Domain status updated to `ACTIVE`.
     - Invokes `syncTraefikRouter(domain)`.
   - If token is missing/mismatched:
     - Domain status set to `ERROR`.
     - Returns detected records and actionable troubleshooting guidance.

3. **Traefik Dynamic Routing (`syncTraefikRouter`)**:
   - Traefik v3 in `docker-compose.yml` mounts `./docker/traefik/dynamic/`.
   - Writes `docker/traefik/dynamic/domain-{domainId}.yml` with direct service loadbalancer routing across `vexlyx-apps`:
     ```yaml
     http:
       routers:
         domain-{domainId}:
           rule: Host(`{domain.hostname}`)
           entryPoints:
             - web
           service: service-{domainId}
       services:
         service-{domainId}:
           loadBalancer:
             servers:
               - url: "http://vexlyx-{serviceName}-{service}-1:{port}"
     ```
   - Seamlessly proxies HTTP traffic to the target container with zero downtime.
   - `{service}` and `{port}` come from `resolveHttpUpstream()` (`domains/upstream.ts`): WordPress and no-build PHP projects run PHP-FPM (`app`, FastCGI on 9000) behind an nginx (`web`, port 80), so their route targets `web`; every other type targets its single `app` container. The function is checked against the Traefik labels in `system/templates/docker-compose/*.yml` by `upstream.test.ts`, so a new template or type that exposes a different service fails the test instead of producing a 502.
   - On every API start, `DomainService.syncAllRoutes()` rewrites the route file of each active, attached domain and leaves files that are already correct alone. This repaired servers whose routes were generated before #150 (WordPress and no-build PHP domains answering 502) on upgrade, with no proxy restart. A hand-edited route file is overwritten at the next start; the files are generated, not configuration.

4. **Domain Deletion (`DELETE /api/domains/:id`)**:
   - Unlinks `docker/traefik/dynamic/domain-{domainId}.yml`.
   - Traefik instantly removes the HTTP router.
   - Deletes domain row from PostgreSQL (cascade deletes associated `dns_records`).

---

## 3. API Reference

### `POST /api/domains`
- **Auth:** Required (Session cookie)
- **Body:**
  ```json
  {
    "hostname": "app.example.com",
    "projectId": "cm1234567890abcdef" // optional
  }
  ```
- **Response (201 Created):**
  ```json
  {
    "id": "dom_abc123",
    "hostname": "app.example.com",
    "status": "PENDING",
    "sslEnabled": false,
    "verificationToken": "vexlyx-verify-a1b2c3d4...",
    "projectId": "cm1234567890abcdef",
    "verificationInstructions": {
      "recordType": "TXT",
      "recordName": "_vexlyx-challenge.app.example.com",
      "recordValue": "vexlyx-verification=vexlyx-verify-a1b2c3d4...",
      "routingRecord": {
        "recordType": "A",
        "recordName": "app.example.com",
        "publicIp": "203.0.113.10"
      }
    }
  }
  ```

### `GET /api/domains`
- **Auth:** Required
- **Query Parameters:** `projectId`, `status`, `search`, `page`, `limit`
- **Response (200 OK):** Array of `DomainResponse` objects.

### `POST /api/domains/:id/verify`
- **Auth:** Required
- **Query Parameters (Testing only):** `?mockRecord=...`
- **Response (200 OK):**
  ```json
  {
    "verified": true,
    "status": "ACTIVE",
    "message": "Domain verified successfully. Traefik traffic routing is active.",
    "expectedRecord": { ... },
    "detectedRecords": [ ... ]
  }
  ```

### `DELETE /api/domains/:id`
- **Auth:** Required
- **Response:** `204 No Content`

---

## 4. Testing

### Automated Test Suite
Run the Python custom domain test suite:
```bash
python tests/test_custom_domains.py
```

Covered test cases:
1. `test_valid_hostnames`: Validates compliant RFC 1123 domain names and subdomains.
2. `test_invalid_hostnames`: Rejects protocols, ports, trailing dots, spaces, invalid chars.
3. `test_traefik_yaml_generation`: Verifies Traefik router configuration format, entryPoints, and Docker service names.
4. `test_verification_match`: Tests token resolution matching and failure rejection.
5. `test_endpoint_unauthorized`: Verifies 401 unauthorized protection on `/api/domains`.

### Monorepo Validation
```bash
pnpm typecheck   # Validates TypeScript across all 3 workspaces
pnpm lint        # Validates ESLint rules
pnpm build       # Validates Next.js and API production builds
```

### Live Verification
Confirmed end-to-end on `panel.mindgera.site`: attached `html.mindgera.site` to a deployed project, verified via TXT (public-resolver check), added the now-surfaced A record, and confirmed it serves trusted HTTPS alongside the project's own default subdomain (F5.10) — both routes work simultaneously without interfering with each other.

---

## 5. UI Integration

- **Project Settings (`DomainPanel`)**: Located at `/projects/[id]`. Allows attaching and verifying domains directly in the context of a project.
- **Global Overview (`/domains`)**: Located at `/domains`. Lists all domains across all projects with filters, search, and a project-selector creation dialog.

---

## 6. Important Decisions

1. **Dedicated Verification Token**: Added `verificationToken String? @map("verification_token")` directly to `Domain` model via Prisma migration `20260902184554_add_domain_verification_token` to guarantee cryptographic unicity and fast indexing.
2. **Traefik Dynamic File Provider**: Utilized Traefik's dynamic file provider (`docker/traefik/dynamic/`) rather than editing container labels. This enables zero-downtime instant routing attachment and detachment without restarting or redeploying the application container.
3. **No External DNS Dependencies**: Implemented DNS resolution using Node's built-in `dns` module and crypto generation using `node:crypto`.
4. **Query public resolvers directly, not the server's own** (added after live-server testing on `panel.mindgera.site`): originally used the default `dns.promises.resolveTxt`, which trusts whatever resolver the host has configured. A cloud provider's local resolver can negative-cache an early failed lookup (e.g. a "Verify" click before DNS propagated) for a long time — observed up to an hour on AWS — even after the record is genuinely live everywhere else. Switched to explicitly querying Cloudflare/Google/Quad9, matching the pattern F3.3's `dns-service.ts checkPropagation()` already used.
5. **Surface the required A record, not just TXT** (same live-testing pass): TXT verification proves ownership but was the *only* thing shown to the admin — a verified domain with no A record just renders nothing, with no indication why. `verificationInstructions` now always includes a `routingRecord` (A record host + the server's public IP from F5.9), and the dashboard's DNS Instructions modal shows it alongside the TXT record.
