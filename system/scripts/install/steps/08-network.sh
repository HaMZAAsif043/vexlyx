#!/usr/bin/env bash
# Creates the two external Docker networks (dev and prod share them):
#   traefik-net  panel-internal: Redis, the API, the panel database, mail, DNS.
#                Project containers never join it.
#   vexlyx-apps  project containers, Traefik and the database servers customer
#                databases live on — the same network docker_manager.py's
#                ensure_apps_network() creates on demand for project containers.
set -euo pipefail

log_step "[8/16] Configuring Docker networks"

for network in traefik-net vexlyx-apps; do
  if docker network inspect "${network}" >/dev/null 2>&1; then
    log_ok "Docker network '${network}' already exists."
  else
    docker network create "${network}"
    log_ok "Created Docker network '${network}'."
  fi
done

# Public IP detection (F5.9) — re-detected every run (not skipped like
# one-time secrets) since it can legitimately change, e.g. after migrating
# to a new host. Feeds the DNS-onboarding guidance printed in the final step
# and exposed to the dashboard via the api container's PUBLIC_IP env var.
log_info "Detecting server's public IP..."
if VEXLYX_PUBLIC_IP="$(detect_public_ip)"; then
  log_ok "Public IP detected: ${VEXLYX_PUBLIC_IP}"
else
  VEXLYX_PUBLIC_IP=""
  log_warn "Could not auto-detect a public IP (no outbound internet and local route lookup failed)."
  log_warn "DNS record guidance at the end of setup will be skipped — set VEXLYX_PUBLIC_IP yourself in ${VEXLYX_SECRETS_FILE} if needed."
fi
upsert_secret VEXLYX_PUBLIC_IP "${VEXLYX_PUBLIC_IP}"
