# SSL Certificate Management (F3.4)

> **Feature:** F3.4 — SSL Certificate Management  
> **Status:** 🟢 COMPLETED  
> **Package:** `@vexlyx/api`, `@vexlyx/dashboard`, `@vexlyx/shared`  
> **Prisma Models:** `Domain`, `Certificate`  
> **Infrastructure:** Traefik v3.4 ACME (Let's Encrypt), Python `ssl_manager.py`  

---

## 1. Overview

SSL Certificate Management provides automated and custom TLS certificate provisioning, validation, encryption, renewal, and expiry monitoring across all domains managed in Vexlyx.

Drawing from best practices in modern cloud control panels (Coolify, CloudPanel, CapRover) and solving the common "silent renewal failure" problem, Vexlyx provides:
1. **Automated Let's Encrypt Provisioning**: Traefik v3 automatically fulfills ACME HTTP-01 challenges on port 80/443 with persistent certificate storage in `docker/traefik/acme.json`.
2. **Wildcard & Custom Certificate Support**: Users can upload manual custom certificates (PEM certificate chain and private key) with client- and server-side pairing validation and AES-256-GCM encrypted private key storage at rest.
3. **Offline / Development Environment Fallback**: Seamless self-signed certificate generation with Subject Alternative Names (SANs) for `.localhost` domains and test suites, allowing complete HTTPS testing without public domain or internet dependencies.
4. **Proactive Certificate Expiry Monitoring (7-Day Alert Threshold)**: Backend monitoring evaluates certificate lifespan. When a certificate is within 7 days of expiration, a prominent alert is raised and status transitions to `EXPIRING_SOON`.
5. **HTTPS Redirection & Security Controls**: One-click toggle for Traefik 301 permanent HTTPS redirection and auto-renewal controls.

---

## 2. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Next.js Dashboard UI                     │
│  - /domains (Global domain overview & SSL status badge)     │
│  - /domains/[id]/ssl (Dedicated SSL Certificate page)       │
│  - Expiry Alert Banner (<= 7 days remaining warning)        │
│  - Validity Progress Countdown, Key-Value attributes grid   │
│  - Custom Certificate Upload Dialog (PEM validation)        │
│  - HTTPS Redirection & Auto-Renewal toggles                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / JSON
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Fastify API Server                      │
│  - GET    /api/domains/ssl/alerts     (Batch expiry audit)  │
│  - GET    /api/domains/:id/ssl        (Get certificate)     │
│  - POST   /api/domains/:id/ssl/provision (Auto Let's Encrypt│
│  - POST   /api/domains/:id/ssl/upload (Custom cert upload)  │
│  - POST   /api/domains/:id/ssl/renew  (Force renewal)       │
│  - PATCH  /api/domains/:id/ssl/settings (Toggles)           │
│  - DELETE /api/domains/:id/ssl        (Disable SSL)         │
└───────────────┬──────────────────────────────┬──────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────────┐ ┌───────────────────────────┐
│     PostgreSQL (Prisma)       │ │  system/python/           │
│  - model Domain               │ │  ssl_manager.py           │
│  - model Certificate          │ │  - self-signed dev certs  │
│    * type (LETS_ENCRYPT, etc) │ │  - key pair validation    │
│    * status (ACTIVE, etc)     │ │  - acme.json parser       │
│    * validFrom, validTo       │ └─────────────┬─────────────┘
│    * commonName, sans         │               │ Writes files
│    * encryptedKey (AES-256)   │               ▼
│    * forceHttps, autoRenew    │ ┌───────────────────────────┐
└───────────────────────────────┘ │ Traefik v3 Container      │
                                  │ - Ports :80 and :443      │
                                  │ - websecure entrypoint    │
                                  │ - certResolver letsencrypt│
                                  │ - /etc/traefik/certs/     │
                                  └───────────────────────────┘
```

---

## 3. Database Schema

```prisma
enum CertType {
  LETS_ENCRYPT
  CUSTOM
  SELF_SIGNED
}

enum CertStatus {
  PENDING
  ACTIVE
  EXPIRING_SOON
  EXPIRED
  ERROR
}

model Certificate {
  id            String      @id @default(cuid())
  domainId      String      @unique @map("domain_id")
  type          CertType    @default(LETS_ENCRYPT)
  status        CertStatus  @default(PENDING)
  issuer        String?
  commonName    String      @map("common_name")
  sans          String[]    @default([])
  validFrom     DateTime?   @map("valid_from")
  validTo       DateTime?   @map("valid_to")
  autoRenew     Boolean     @default(true) @map("auto_renew")
  forceHttps    Boolean     @default(true) @map("force_https")
  certPath      String?     @map("cert_path")
  keyPath       String?     @map("key_path")
  encryptedKey  String?     @map("encrypted_key")
  serialNumber  String?     @map("serial_number")
  errorMessage  String?     @map("error_message")
  lastCheckedAt DateTime?   @map("last_checked_at")
  lastRenewedAt DateTime?   @map("last_renewed_at")
  createdAt     DateTime    @default(now()) @map("created_at")
  updatedAt     DateTime    @updatedAt @map("updated_at")

  domain        Domain      @relation(fields: [domainId], references: [id], onDelete: Cascade)

  @@index([status])
  @@index([validTo])
  @@map("certificates")
}
```

---

## 4. Traefik Dynamic Router Configuration

When SSL is enabled for a domain, Vexlyx automatically updates `docker/traefik/dynamic/domain-{domainId}.yml`:

```yaml
# Auto-generated by Vexlyx with SSL for domain: app.example.com
# Project: web-app (cmtl9...)
http:
  routers:
    domain-cmtl9...-http:
      rule: Host(`app.example.com`)
      priority: 100
      entryPoints:
        - web
      middlewares:
        - redirect-to-https-cmtl9...
      service: service-cmtl9...
    domain-cmtl9...-https:
      rule: Host(`app.example.com`)
      priority: 100
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
      service: service-cmtl9...
  middlewares:
    redirect-to-https-cmtl9...:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    service-cmtl9...:
      loadBalancer:
        servers:
          - url: "http://vexlyx-web-app-app-1:3000"
```

For custom certificates, the TLS router config references the mounted certificate files:

```yaml
tls:
  certificates:
    - certFile: /etc/traefik/certs/domain-cmtl9....crt
      keyFile: /etc/traefik/certs/domain-cmtl9....key
```

---

## 5. Expiry Monitoring & Alert Policy

1. **Active Window (`> 7 days`)**:
   - Status remains `ACTIVE`.
   - Green badge displayed on dashboard with days remaining counter.
2. **Alert Threshold (`<= 7 days`)**:
   - Status transitions to `EXPIRING_SOON`.
   - Prominent amber alert banner displayed on `/domains/[id]/ssl` and card badge on `/domains`.
   - Informs administrator that certificate renewal is imminent.
3. **Expired (`<= 0 days`)**:
   - Status transitions to `EXPIRED`.
   - Rose alert banner displayed with one-click renew trigger.

### Tenant scoping of the batch audit

`GET /api/domains/ssl/alerts` (and the dashboard SSL banner/feed built on `SslService.checkExpiryAlerts(userId)`) only audits certificates of domains owned by the caller (`where: { domain: { userId } }`) — the same owner-only rule every other SSL operation uses. It previously scanned every certificate in the database, so any authenticated account could list other tenants' hostnames and expiry dates (#43), and each call also refreshed other tenants' certificate status as a side effect. The admin role does not widen this: admins cannot read other users' certificates through `GET /api/domains/:id/ssl` either, so the audit stays consistent with it. If a server-wide expiry view is ever needed, add it as an explicit ADMIN-only endpoint rather than loosening this one.

Automated: `apps/api/src/modules/domains/ssl-service.test.ts` (query is scoped to the user, alert thresholds, status refresh only on change) and `routes.test.ts` (401 without a session; service called with the authenticated user id).

---

## 6. How to Test

Run the automated test suite:
```bash
python tests/test_ssl_management.py
```

Expected output:
```text
test_01_self_signed_cert_generation ... ok
test_02_cert_parsing_and_expiry_detection ... ok
test_03_validate_key_pair_matching_and_mismatch ... ok
test_docker_compose_traefik_ports ... ok
test_expiry_thresholds ... ok
test_traefik_static_config ... ok
test_01_unauthenticated_endpoints_return_401 ... ok

----------------------------------------------------------------------
Ran 7 tests in 11.523s

OK
```
