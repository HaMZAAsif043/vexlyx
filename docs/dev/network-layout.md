# Network Layout

Vexlyx keeps the panel's own services and customer projects on separate Docker networks, so a project container can only reach what it needs to serve a site.

## Networks

| Network | Created by | Members |
|---------|-----------|---------|
| `traefik-net` | installer step 8, `scripts/dev-setup.mjs` | Panel-internal: `redis`, `api`, `dashboard`, `postgres`, `mysql`, `dovecot`, `postfix`, `coredns`, `roundcube`, `adminer`, `traefik` |
| `vexlyx-apps` | installer step 8, `scripts/dev-setup.mjs`, `docker_manager.py` (`ensure_apps_network`) | Every project container, `traefik`, `postgres`, `mysql` |

Both are external networks, declared in `docker-compose.yml`. The name `traefik-net` is kept for the panel-internal network so existing servers do not have to recreate every panel container.

Why each member is where it is:

- **Traefik** routes to the panel (`traefik-net`) and to projects (`vexlyx-apps`), so it joins both.
- **PostgreSQL and MySQL** hold the databases created from the Databases page. Projects receive `DB_HOST=vexlyx-postgres` (or `vexlyx-mysql`) and per-database credentials, so the servers must be reachable from `vexlyx-apps`. They stay on `traefik-net` for the API and Adminer.
- **Redis, the API, Dovecot, Postfix, CoreDNS** are not reachable from a project. The API drives Docker through the Python layer and the mounted socket; it does not dial project containers.

The API and the Python layer reach projects only through the Docker CLI (`deploy`, `exec`, `logs`, `status`), never over the network, which is why the split costs nothing at run time.

## Redis authentication

Redis starts with `--requirepass "$REDIS_PASSWORD"`. The installer generates `REDIS_PASSWORD` once into `/etc/vexlyx/vexlyx.env` (32 random bytes, hex) and never replaces an existing value. `docker-compose.prod.yml` refuses to start without it and passes `REDIS_URL=redis://:<password>@redis:6379` to the API. The development compose file defaults to `vexlyx_dev`; the API rejects that password, and any URL without one, when `NODE_ENV=production`.

`apps/api/src/config/redisConnection.ts` turns `REDIS_URL` into connection options so BullMQ authenticates exactly like the main client.

## Project templates

Every file in `system/templates/docker-compose/` declares one external network, `vexlyx-apps`, as `default`. A template must not declare another network, join `traefik-net`, set `network_mode`, or mount the Docker socket. `tests/test_network_isolation.py` fails if one does.

## Upgrading an existing server

Running the installer on a server from before this layout:

1. Step 6 adds `REDIS_PASSWORD` to the secrets file if it is missing.
2. Step 8 creates `vexlyx-apps`.
3. Step 11 recreates `postgres`/`mysql` (they joined a network) and `redis` (its command changed), then verifies Redis refuses an unauthenticated `PING`. Redis data lives in a volume, so queued jobs and sessions are kept.
4. Step 14 recreates Traefik (it joined a network) and the API/dashboard, then runs `node dist/scripts/migrate-project-network.js`. For each project that is not deleted, the `migrate_network` action connects its containers to `vexlyx-apps` (keeping their aliases), disconnects them from `traefik-net`, and rewrites the network name in its `deploy/docker-compose.yml`. Running containers are not restarted and stopped ones stay stopped. Each running nginx `web` container is then reloaded (restarted if the reload fails), because nginx resolves its PHP-FPM upstream once at startup and would otherwise keep sending requests to the app container's old address. A project where that fails counts as failed and is retried, and the reload repeats on every attempt so a retry also repairs a site left stale. Normal deploys do not do this: a fresh deploy resolves correctly. The script writes `.migrations/apps-network-v1` next to the projects directory only when every project succeeded, so a failure is retried on the next run.

A project redeployed after the upgrade is generated from the new templates and needs no migration.

## Extending

- **A new project template:** copy an existing one, keep the `networks:` block pointing at `vexlyx-apps`, and add it to nothing else; the regression test discovers it by globbing the directory.
- **A new panel service:** put it on `traefik-net` only. If Traefik must route to it, label it with `traefik.docker.network=traefik-net`.
- **A new service that projects must reach** (another database server, for example): it has to join `vexlyx-apps`, so give it its own credentials per tenant, never a shared administrative account, and add it to the allow-list in `StackNetworksTest.test_only_traefik_and_the_database_servers_join_the_apps_network`.
- **A new Redis client:** build it from `env.REDIS_URL` (`new Redis(env.REDIS_URL)` or `parseRedisUrl`), never from a host and port.

## Limits

Projects share `vexlyx-apps` with each other and with the database servers. Per-project network isolation and a dedicated PostgreSQL instance for customer databases (so that the panel's own database is not on a network projects can reach) are not part of this layout.
