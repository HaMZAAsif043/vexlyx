#!/usr/bin/env bash
# Builds the dashboard and api container images. Needs to happen before the
# migration/admin-user steps, which run one-off tasks against the api image
# via `docker compose run`.
set -euo pipefail

log_step "[10/16] Building panel Docker images"

COMPOSE=(docker compose --env-file "${VEXLYX_SECRETS_FILE}" -f docker-compose.yml -f docker-compose.prod.yml)

# postfix and dovecot are built here too: if `up -d` in step 14 builds them
# first, compose tries to pull their names from Docker Hub and prints
# "pull access denied" errors before building them locally.
"${COMPOSE[@]}" build dashboard api postfix dovecot

# User projects are built by Nixpacks inside the api container, so verify it
# there. Without it every Git deployment fails, which would otherwise only show
# up on the first deploy.
if nixpacks_version="$(docker run --rm --entrypoint nixpacks vexlyx-api:latest --version 2>&1)"; then
  log_ok "Nixpacks ready in the API image (${nixpacks_version})."
else
  log_warn "Nixpacks is not available in the API image (${nixpacks_version}) — project builds will fail. Re-run this installer to rebuild the image."
fi

# vexlyx-ufw-helper (F5.4) -- a throwaway, host-networked image
# firewall_manager.py launches per-command to reach the HOST's real UFW
# state (the api container itself has no NET_ADMIN/host networking). Not a
# compose service -- built directly so `docker run` can find it by tag.
docker build -t vexlyx-ufw-helper:latest docker/ufw-helper

# vexlyx-php-fpm (F5.21) -- fixed PHP-FPM image (with common extensions
# baked in) that no-build PHP projects deploy against instead of running a
# per-project Nixpacks build. See system/templates/docker-compose/php-no-build.yml.
docker build -t vexlyx-php-fpm:8.3 docker/php-fpm

log_ok "Panel images built."
