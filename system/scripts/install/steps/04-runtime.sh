#!/usr/bin/env bash
# Node.js 22 + pnpm and Python 3 + cryptography + psutil — the toolchain the
# panel needs on the host to build itself (F5.1 runs `pnpm build` directly on
# the host — see step 09) and for the system scripts. psutil backs
# system_monitor.py's server_metrics collector (F5.2/F5.13) — without it,
# metrics still work via /proc parsing but with no per-core CPU breakdown.
set -euo pipefail
#
# Nixpacks is deliberately NOT installed here. User projects are built by the
# api container (build_manager.py runs inside it), which ships its own pinned
# copy — see apps/api/Dockerfile. A second copy on the host was never used, and
# its "could not be verified" warning only confused people. Step 10 checks
# Nixpacks where it actually runs.

log_step "[4/16] Installing Node.js, pnpm, and Python"

export DEBIAN_FRONTEND=noninteractive

# Node 22+ is required, not just 20+: pnpm 11 (pinned in package.json's
# packageManager field) uses the node:sqlite built-in, which doesn't exist
# before Node 22 and fails with ERR_UNKNOWN_BUILTIN_MODULE on Node 20.
if has_cmd node && [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge 22 ]]; then
  log_ok "Node.js already installed ($(node -v))."
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
  log_ok "Node.js installed ($(node -v))."
fi

# The pnpm version is pinned, so downloading it is intended; without this
# corepack asks for confirmation, which nobody can answer in `curl | bash`.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
corepack prepare pnpm@11.24.0 --activate
log_ok "pnpm ready ($(pnpm --version))."

apt-get install -y --no-install-recommends python3 python3-pip python3-venv
# The API spawns Python as literally `python` (not `python3`) on several
# call sites (apps/api/src/modules/{build,deploy,wordpress,dockerfile,databases}/
# service.ts) — Ubuntu ships no `python` binary by default, so those spawns
# would fail with ENOENT without this.
if ! has_cmd python; then
  ln -sf "$(command -v python3)" /usr/local/bin/python
fi
pip3 install --break-system-packages --no-cache-dir cryptography psutil
log_ok "Python ready ($(python --version))."
