#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
docker build -t vexlyx-postfix:issue36-test docker/postfix
docker build -t vexlyx-dovecot:issue36-test docker/dovecot
docker build -t vexlyx-mail-state-runner:issue36-test -f tests/mail-state/Dockerfile.runner .
docker run --rm --entrypoint python3 -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD:/workspace:ro" vexlyx-mail-state-runner:issue36-test -m unittest discover -s system/python -p 'test_mail_*.py' -v
volume="vexlyx-issue36-$(date +%s)-$$"
docker volume create "$volume" >/dev/null
trap 'docker volume rm "$volume" >/dev/null' EXIT HUP INT TERM
# Prevent the non-root writer from accidentally inheriting Docker socket access.
docker run --rm --user 0:65534 --entrypoint python3 -e "VEXLYX_TEST_STATE_VOLUME=$volume" -e PYTHONDONTWRITEBYTECODE=1 --mount "type=volume,source=$volume,target=/state" -v "$PWD:/workspace:ro" -v /var/run/docker.sock:/var/run/docker.sock vexlyx-mail-state-runner:issue36-test tests/mail-state/test_live_mail_state.py
