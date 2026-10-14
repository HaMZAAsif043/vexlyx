# GitHub Integration

Vexlyx uses one GitHub App per panel installation. An administrator completes the one-time App setup through GitHub's manifest flow or enters an existing App's credentials. After that setup, the creation controls are hidden and every user gets a direct **Connect GitHub** action, installs the panel App on a personal account or organization, and chooses repositories on GitHub.

## GitHub App configuration

The API builds callback and webhook URLs from `API_BASE_URL` and refuses to start the manifest flow unless it is a public HTTPS URL. Request headers are never used to construct security-sensitive URLs.

The manifest callback URL is submitted without query parameters. The single-use CSRF `state` is attached to the GitHub registration form action, and GitHub returns it alongside the manifest conversion code. This follows GitHub's manifest protocol and keeps the callback URL valid.

The generated App requests repository Contents read access and Metadata read access. It subscribes to push events; GitHub also sends installation and installation-repository lifecycle events required to keep connections synchronized.

The App ID, slug, and client ID are stored as identifiers. The private key, client secret, and webhook secret are encrypted with the existing AES-256-GCM encryption helper. API responses expose only non-secret status fields.

### Production prerequisites

- `API_BASE_URL` must be the public HTTPS API origin, for example `https://api.panel.example.com`.
- `CORS_ORIGIN` must be the public dashboard origin, for example `https://panel.example.com`.
- When the dashboard and API use sibling subdomains, `COOKIE_DOMAIN` must be their shared parent domain so the authorization callback receives the logged-in session.
- Redis must be available for single-use authorization state and webhook delivery deduplication.
- `ENCRYPTION_KEY` should be set independently from `SESSION_SECRET` in production.

The production Compose overlay already derives these origins from `VEXLYX_DOMAIN` and configures the shared cookie domain.

### Manual App configuration

The fallback form requires the App ID, slug, client ID, client secret, PEM private key, and webhook secret. Configure the existing App with:

- Callback URL: `<API_BASE_URL>/api/github/installations/callback`
- Webhook URL: `<API_BASE_URL>/api/webhooks/github-app`
- Request user authorization during installation: enabled
- Repository permissions: Contents read, Metadata read
- Event: Push

GitHub delivers installation and installation-repository lifecycle events to Apps automatically. The private key and App ID are verified against GitHub before manual credentials replace the current configuration.

## Installation linking

Before redirecting to GitHub, Vexlyx stores a random state value in Redis for ten minutes. The state is single-use and bound to the current Vexlyx user, session, and operation.

The App requests GitHub user authorization during installation. At the callback, Vexlyx exchanges the authorization code, calls `GET /user/installations`, and confirms the returned installation ID is accessible to that user. The GitHub user token is discarded after this check and is never stored.

An installation belongs to one Vexlyx user. The database write includes the authenticated owner in its predicate and never updates the owner field. Concurrent attempts by different users cannot transfer ownership; the losing attempt receives `409 GITHUB_INSTALLATION_ALREADY_LINKED`. The existing owner can reconnect. Concurrent initial creation can also return this conflict to the same owner; retry the connection flow with fresh authorization state.

GitHub does not allow an App to use both “Request user authorization during installation” and a separate setup URL. Vexlyx therefore completes installation linking in the OAuth callback. The `installation_id` query parameter is never trusted without the `/user/installations` verification.

## Repository authorization and tokens

Every installation, repository, and branch route first scopes the installation to the authenticated Vexlyx user. Repository IDs are resolved through the installation API again when connecting a project.

Vexlyx signs GitHub App JWTs with Node's built-in `crypto` module and exchanges them for installation tokens. Tokens are cached only in process memory until shortly before expiry. They are never stored in PostgreSQL, Redis, files, logs, or audit metadata.

## Clone and pull behavior

Installation tokens are passed to `git_manager.py` through stdin. The script exposes the token to Git through temporary process environment configuration and an HTTP authorization header. The repository remote remains the ordinary credential-free HTTPS clone URL, so `.git/config` never contains a token.

The build worker obtains a fresh installation token before every GitHub-backed fetch or pull. Manual repositories continue using their existing HTTPS or SSH/deploy-key path.

Switching a project to the manual flow clears its GitHub relationship and Git URL but preserves the checked-out workspace and running container. The user can then enter a manual URL and credentials. A suspended or disconnected GitHub project cannot silently build stale source; Git synchronization fails until the connection is restored or switched to manual.

## Webhooks

`POST /api/webhooks/github-app` validates the raw request body with the encrypted App webhook secret. Invalid or missing signatures return 401. `x-github-delivery` values are claimed atomically in Redis for 24 hours to prevent duplicate deployments; failed processing releases the claim so GitHub can retry.

Push events are matched by numeric installation and repository IDs, then filtered by each project's configured branch. Installation suspension, uninstall, and repository removal mark affected projects disconnected without stopping their running containers.

The legacy per-project GitHub webhook remains available for manually connected projects.

### Delivery lifecycle

- `push`: queues deployments only for projects matching the numeric installation ID, repository ID, and branch.
- `installation.suspend`: marks the installation and its projects suspended.
- `installation.unsuspend`: restores projects that were suspended with the installation.
- `installation.deleted`: marks affected projects disconnected.
- `installation_repositories.removed`: marks projects for removed repositories unavailable.

Lifecycle changes never stop or remove an already-running container.

## API endpoints

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/github/app` | Authenticated | Return non-secret App readiness and status |
| `POST` | `/api/github/app/manifest` | Admin | Start manifest creation |
| `GET` | `/api/github/app/manifest/callback` | Admin callback | Exchange the manifest code and store encrypted credentials |
| `PUT` | `/api/github/app` | Admin | Validate and save an existing App |
| `POST` | `/api/github/installations/connect` | Authenticated | Start account or organization installation |
| `GET` | `/api/github/installations/callback` | Authenticated callback | Verify ownership and link the installation |
| `GET` | `/api/github/installations` | Authenticated | List only the caller's installations |
| `DELETE` | `/api/github/installations/:id` | Owner | Disconnect an installation locally |
| `GET` | `/api/github/installations/:id/repositories` | Owner | List/search accessible repositories |
| `GET` | `/api/github/installations/:id/repositories/:repoId/branches` | Owner | List authorized branches |
| `POST` | `/api/projects/:id/git/connect-github` | Project owner | Verify, clone, and connect a repository |
| `POST` | `/api/projects/:id/git/disconnect-github` | Project owner | Switch the project back to manual Git |
| `POST` | `/api/webhooks/github-app` | Signed GitHub webhook | Process App push and lifecycle events |

## Data model and migration

Migration `20261010120000_add_github_integration` adds:

- `GitHubApp`: singleton App identity and encrypted credentials.
- `GitHubInstallation`: GitHub account identity, repository selection, Vexlyx owner, and lifecycle state.
- Optional Project fields for installation, numeric repository ID, full name, connection state, and disconnect reason.

GitHub numeric IDs are stored as PostgreSQL `BIGINT` and serialized as strings in API responses to avoid JavaScript precision loss. Apply the migration before using the Settings card:

```bash
cd apps/api
pnpm db:migrate
```

## Local testing

GitHub cannot deliver callbacks or webhooks to localhost. The complete flow also needs the browser's Vexlyx session cookie to reach the callback. The most reliable development topology is one public HTTPS origin in front of a local reverse proxy:

- `/api/*` routes to Fastify on port 5000.
- All other paths route to Next.js on port 3000.
- `API_BASE_URL`, `CORS_ORIGIN`, and dashboard `NEXT_PUBLIC_API_URL` all use that public origin.
- Open and sign into Vexlyx through the public origin before starting App creation.

Alternatively, use dashboard and API subdomains under the same parent domain and set `COOKIE_DOMAIN` to that parent. Exposing only the API while using the dashboard on `localhost` is unreliable because cross-site cookie rules can make the callback unauthenticated.

The Settings card reports whether `API_BASE_URL` is public HTTPS before starting App creation. Unit tests and mocked service behavior can run without a tunnel; real manifest callbacks, installations, and webhooks cannot.

## Troubleshooting

- **Create GitHub App is disabled:** `API_BASE_URL` is not public HTTPS or resolves to a localhost hostname.
- **Callback returns 401:** the browser did not send the Vexlyx session cookie. Open the panel through its public origin and check `COOKIE_DOMAIN` for split subdomains.
- **No repositories appear:** confirm the App installation includes the repository and is not suspended or locally disconnected.
- **Clone returns 401/403:** reconnect the installation and confirm Contents read permission remains granted.
- **Push does not deploy:** confirm the project connection is healthy, the pushed branch matches exactly, and GitHub shows a successful delivery to `/api/webhooks/github-app`.
- **Repository removal banner remains:** restore repository access in the GitHub installation, then reconnect the project so access is revalidated.
- **Replacing the App breaks existing installations:** installations belong to the old App. Reinstall and relink the replacement App.

## Extending providers

GitHub-specific authentication and REST behavior live under `apps/api/src/modules/github`. Generic source synchronization remains in the Git service and `git_manager.py`. A future provider should implement repository discovery and short-lived credential acquisition while continuing to call the same credential-safe Git runner.

## Verification

Run:

```bash
pnpm typecheck
pnpm test
python -m unittest tests/test_github_app_git_credentials.py
```

Live validation requires a public HTTPS panel and a GitHub account capable of creating and installing an App. Verify private cloning, branch filtering, duplicate delivery handling, suspension, repository removal, uninstall, and the absence of credentials in `.git/config`.
