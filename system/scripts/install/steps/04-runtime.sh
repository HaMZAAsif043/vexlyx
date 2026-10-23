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
  # Installed from NodeSource's apt repository, never by running a script
  # downloaded at install time: the signing key is only trusted when its
  # fingerprint matches the one committed in nodesource.fingerprint, and the
  # repository is pinned to the Node major version this release needs.
  NODESOURCE_MAJOR=22
  NODESOURCE_KEY_URL="${VEXLYX_NODESOURCE_KEY_URL:-https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key}"
  NODESOURCE_KEYRING="${VEXLYX_APT_KEYRING_DIR:-/etc/apt/keyrings}/nodesource.gpg"
  NODESOURCE_LIST="${VEXLYX_APT_SOURCES_DIR:-/etc/apt/sources.list.d}/nodesource.list"
  NODESOURCE_FINGERPRINT_FILE="${VEXLYX_NODESOURCE_FINGERPRINT_FILE:-${SCRIPT_DIR}/nodesource.fingerprint}"

  expected_fingerprint="$(grep -Eixm1 '[0-9A-F]{40}' "${NODESOURCE_FINGERPRINT_FILE}" | tr 'a-f' 'A-F')"
  [[ -n "${expected_fingerprint}" ]] || die "No NodeSource key fingerprint found in ${NODESOURCE_FINGERPRINT_FILE}."

  nodesource_key_file="$(mktemp)"
  curl -fsSL "${NODESOURCE_KEY_URL}" -o "${nodesource_key_file}"
  # `gpg --dearmor` below converts the WHOLE file into the keyring apt trusts,
  # so checking one fingerprint is not enough: a second key appended after the
  # genuine one would be trusted too. The file must hold exactly one primary
  # key (a `pub` record, no secret key) and that key must be the pinned one.
  # The fingerprint is the first fpr record after the `pub` record; its
  # subkeys follow it.
  key_listing="$(gpg --show-keys --with-colons "${nodesource_key_file}" 2>/dev/null || true)"
  primary_key_count="$(printf '%s\n' "${key_listing}" | awk -F: '$1 == "pub" || $1 == "sec" { n++ } END { print n + 0 }')"
  actual_fingerprint="$(printf '%s\n' "${key_listing}" | awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; exit }' | tr 'a-f' 'A-F')"
  if [[ "${primary_key_count}" != 1 ]] || printf '%s\n' "${key_listing}" | grep -q '^sec:'; then
    rm -f "${nodesource_key_file}"
    die "The downloaded NodeSource key file must contain exactly one public key, found ${primary_key_count}. Refusing to trust it."
  fi
  if [[ "${actual_fingerprint}" != "${expected_fingerprint}" ]]; then
    rm -f "${nodesource_key_file}"
    die "The NodeSource signing key does not match the pinned fingerprint (expected ${expected_fingerprint}, got ${actual_fingerprint:-none}). Refusing to install Node.js from it."
  fi

  install -d -m 0755 "$(dirname "${NODESOURCE_KEYRING}")" "$(dirname "${NODESOURCE_LIST}")"
  gpg --dearmor < "${nodesource_key_file}" > "${NODESOURCE_KEYRING}.tmp"
  mv -f "${NODESOURCE_KEYRING}.tmp" "${NODESOURCE_KEYRING}"
  chmod 0644 "${NODESOURCE_KEYRING}"
  rm -f "${nodesource_key_file}"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=${NODESOURCE_KEYRING}] https://deb.nodesource.com/node_${NODESOURCE_MAJOR}.x nodistro main" > "${NODESOURCE_LIST}"

  # Without this a newer distro "nodejs" could win over the pinned repository.
  NODESOURCE_PIN="${VEXLYX_APT_PREFERENCES_DIR:-/etc/apt/preferences.d}/nodejs"
  install -d -m 0755 "$(dirname "${NODESOURCE_PIN}")"
  printf 'Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
' > "${NODESOURCE_PIN}"

  apt-get update
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
