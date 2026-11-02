#!/usr/bin/env bash
# Brings up the stateful services first and waits for their health checks
# before anything that depends on them (migrations, admin user creation).
set -euo pipefail

log_step "[11/16] Starting database services"

COMPOSE=(docker compose --env-file "${VEXLYX_SECRETS_FILE}" -f docker-compose.yml -f docker-compose.prod.yml)

"${COMPOSE[@]}" up -d postgres mysql redis

wait_healthy() {
  local container="$1" tries=30
  while (( tries > 0 )); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "${container}" 2>/dev/null || echo "starting")"
    [[ "${status}" == "healthy" ]] && { log_ok "${container} is healthy."; return 0; }
    sleep 2
    (( tries-- ))
  done
  die "${container} did not become healthy in time. Check: docker logs ${container}"
}

wait_healthy vexlyx-postgres
wait_healthy vexlyx-mysql
wait_healthy vexlyx-redis

# Redis must refuse unauthenticated clients. Compose recreates the container
# when its command or environment changed, which is what an upgrade from a
# passwordless install relies on; this check makes that explicit and recreates
# it by hand if compose left the old process running (data lives in the volume).
redis_open() {
  docker exec vexlyx-redis redis-cli ping 2>&1 | grep -q PONG
}
if redis_open; then
  log_warn "Redis still accepts unauthenticated connections; recreating it with the configured password."
  "${COMPOSE[@]}" up -d --force-recreate --no-deps redis
  wait_healthy vexlyx-redis
  if redis_open; then
    die "Redis still accepts unauthenticated connections after being recreated. Check REDIS_PASSWORD in ${VEXLYX_SECRETS_FILE}."
  fi
fi
log_ok "Redis requires a password."
