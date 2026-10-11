# API reference

Vexlyx exposes a JSON API under `/api`. The dashboard is the primary supported client, and most endpoints require the `vexlyx_session` HTTP-only cookie created at sign-in.

## Interactive reference

Every Vexlyx API instance publishes documentation generated from its registered Fastify routes:

- Interactive Swagger UI: `https://api.<panel-domain>/documentation/`
- OpenAPI 3.1 JSON: `https://api.<panel-domain>/documentation/json`
- OpenAPI YAML: `https://api.<panel-domain>/documentation/yaml`

For local development, open `http://localhost:5000/documentation/`.

The specification is generated at runtime, so it always reflects the routes registered by that installed version. Use the specification from the same Vexlyx instance that your client targets.

## Current reference

- [API architecture and conventions](/reference/api-setup)
- [Authentication and sessions](/reference/authentication)
- [Projects API](/reference/projects-api)
- [GitHub integration endpoints](/reference/github-integration)
- [Domains and DNS](/reference/domains)
- [Database provisioning](/reference/database-provisioning)
- [Audit log](/reference/audit-log)

## Conventions

### Authentication

Protected endpoints use the `vexlyx_session` HTTP-only cookie. Sign in through `POST /api/auth/login`, retain the response cookie, and send it with subsequent requests. Browser clients must use credentialed requests. Public health, authentication bootstrap, and signed webhook endpoints are marked without session-cookie security in the specification.

Never place a session ID, reset token, GitHub token, or webhook secret in a URL or log.

### Responses

API errors use a stable JSON envelope:

```json
{
  "error": "Human-readable message",
  "code": "ERROR_CODE",
  "details": {}
}
```

Protected requests authenticate with the session cookie; do not put session identifiers in URLs or application logs. Mutating requests are validated with shared Zod schemas, and authorization is enforced independently of client-side visibility.

### Pagination and authorization

List endpoints that support pagination accept the parameters documented for that operation. Resource ownership is always enforced by the API: hiding an item in the dashboard is not an authorization boundary. Depending on the resource, an inaccessible identifier returns `403` or `404` to avoid disclosing its existence.

## Maintaining the specification

`@fastify/swagger` is registered before application routes and discovers every Fastify endpoint. The OpenAPI plugin supplies operation IDs, resource tags, session security, and the shared error model when a route does not provide more specific metadata. Route-specific schemas remain authoritative and should describe parameters, request bodies, success responses, and examples whenever an endpoint is added or changed.

The API test suite verifies that the machine-readable specification and interactive reference remain available.
