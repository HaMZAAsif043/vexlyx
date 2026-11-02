#!/usr/bin/env bash
# Renders docker/traefik/traefik.prod.yml from its .tmpl with the real ACME
# email. Regenerated on every run (cheap, deterministic, installer-owned —
# not a file operators are expected to hand-edit) so a changed admin email
# is picked up on re-run instead of needing a manual reset.
set -euo pipefail

log_step "[7/16] Rendering production Traefik config"

python3 system/python/mail_state_migrate.py --source "${VEXLYX_HOME}" --state-root "${VEXLYX_MAIL_STATE_DIR}"

render_traefik_config \
  docker/traefik/traefik.prod.yml.tmpl docker/traefik/traefik.prod.yml "${VEXLYX_ADMIN_EMAIL}"

log_ok "docker/traefik/traefik.prod.yml rendered."

# docker/traefik/acme.json is gitignored, so on a fresh checkout it doesn't
# exist yet. If Docker Compose is left to bind-mount a missing file, it
# auto-creates it as root:root 644 — and Traefik refuses to use an ACME
# storage file that isn't exactly 600, silently disabling the letsencrypt
# resolver (every router referencing it then logs "nonexistent certificate
# resolver"). `touch` is a no-op on an existing file, so this never discards
# real certificate data on a re-run.
touch docker/traefik/acme.json
chmod 600 docker/traefik/acme.json
log_ok "docker/traefik/acme.json ready (mode 600)."

# Production mail containers mount this directory read-only. Seed a temporary
# certificate so their first start is reliable while Traefik completes ACME;
# step 14 replaces it with the trusted certificate before install completion.
mkdir -p docker/mail-data/certs
if [[ ! -s docker/mail-data/certs/cert.pem || ! -s docker/mail-data/certs/key.pem ]]; then
  openssl req -new -newkey rsa:2048 -days 1 -nodes -x509 \
    -subj "/O=Vexlyx Development/CN=${VEXLYX_MAIL_HOSTNAME}" \
    -addext "subjectAltName=DNS:${VEXLYX_MAIL_HOSTNAME}" \
    -keyout docker/mail-data/certs/key.pem \
    -out docker/mail-data/certs/cert.pem >/dev/null 2>&1
fi
chmod 600 docker/mail-data/certs/key.pem
chmod 644 docker/mail-data/certs/cert.pem
