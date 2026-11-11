#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
test_dir="$(mktemp -d)"
container="vexlyx-autoconfig-test-$$"
fixture_pid=""
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; fi
  rm -rf "$test_dir"
}
trap cleanup EXIT
mkdir -p "$test_dir/docker/traefik/dynamic" "$test_dir/docker/traefik/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=example.test -addext subjectAltName=DNS:example.test \
  -keyout "$test_dir/docker/traefik/certs/domain-d1.key" \
  -out "$test_dir/docker/traefik/certs/domain-d1.crt" >/dev/null 2>&1
export SESSION_SECRET=autoconfig-integration-session-secret-at-least-32-characters
export HOSTED_MAIL_HOSTNAME=mx.provider.test
cd "$repo"
# Invoke Node directly so signals reach the fixture, rather than a pnpm wrapper.
node --import tsx tests/mail-autoconfig/fixture.mts "$test_dir" >"$test_dir/fixture.log" 2>&1 &
fixture_pid=$!
for attempt in $(seq 1 40); do
  if grep -q 'fixture ready' "$test_dir/fixture.log"; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$test_dir/fixture.log"; exit 1; fi
  sleep 1
done
grep -q 'fixture ready' "$test_dir/fixture.log"
docker run -d --name "$container" \
  --add-host=vexlyx-api:host-gateway \
  --add-host=vexlyx-project12345-app-1:host-gateway \
  -p 127.0.0.1:8080:80 -p 127.0.0.1:8443:443 \
  -v "$test_dir/docker/traefik/dynamic:/etc/traefik/dynamic:ro" \
  -v "$test_dir/docker/traefik/certs:/etc/traefik/certs:ro" \
  traefik:v3.6 --entrypoints.web.address=:80 --entrypoints.websecure.address=:443 \
  --providers.file.directory=/etc/traefik/dynamic --providers.file.watch=true >/dev/null
export AUTOCONFIG_TEST_DIR="$test_dir" AUTOCONFIG_FIXTURE_PID="$fixture_pid"
python3 tests/mail-autoconfig/verify.py
