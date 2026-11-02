#!/usr/bin/env bash
# Creates the admin user via a one-off api container run. create-admin.ts
# only ever creates — see apps/api/prisma/create-admin.ts — so re-running
# this after an admin already exists is a safe no-op that never resets
# their password.
set -euo pipefail

log_step "[13/16] Creating admin user"

COMPOSE=(docker compose --env-file "${VEXLYX_SECRETS_FILE}" -f docker-compose.yml -f docker-compose.prod.yml)

# The output is inspected so the summary only presents a password when this
# run really created the account: on a re-run the account already exists, its
# password is left alone, and a freshly generated one would be meaningless.
admin_output=""
if ! admin_output="$("${COMPOSE[@]}" run --rm --no-deps \
  -e VEXLYX_ADMIN_EMAIL="${VEXLYX_ADMIN_EMAIL}" \
  -e VEXLYX_ADMIN_PASSWORD="${VEXLYX_ADMIN_PASSWORD}" \
  -e VEXLYX_ADMIN_NAME="${VEXLYX_ADMIN_NAME}" \
  api pnpm exec tsx prisma/create-admin.ts 2>&1)"; then
  printf '%s\n' "${admin_output}"
  die "Creating the admin user failed."
fi
printf '%s\n' "${admin_output}"
if [[ "${admin_output}" == *"Created admin user:"* ]]; then
  ADMIN_USER_CREATED=true
fi
