#!/usr/bin/env bash
# ==============================================================================
# Vexlyx Installer — orchestrator (F5.1)
# Invoked by install.sh once the Vexlyx checkout is in place at VEXLYX_HOME.
# Expects to be run with cwd = VEXLYX_HOME (install.sh does this).
# Runs every script under steps/ in order; each step is independently
# idempotent, so re-running this whole script is always safe.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
# shellcheck source=config.sh
source "${SCRIPT_DIR}/config.sh"

require_root

install -d -m 0700 "${VEXLYX_SECRETS_DIR}"
touch "${VEXLYX_STATE_FILE}"
# fd 3 keeps the operator's real stdout, outside the tee below, so a secret
# (the generated admin password) can be shown to the operator without ever
# being written to the install log. See show_secret_to_operator in lib.sh.
exec 3>&1
exec > >(tee -a "${VEXLYX_STATE_FILE}") 2>&1

trap 'on_error ${LINENO}' ERR

echo "======================================================"
echo "  Vexlyx Installer"
echo "======================================================"

for step in "${SCRIPT_DIR}"/steps/*.sh; do
  # shellcheck source=/dev/null
  source "${step}"
done

log_step "Install complete."
