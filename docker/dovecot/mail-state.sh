#!/bin/sh
set -eu

root=/var/lib/vexlyx-mail/dovecot
action=${1:-health}
generation=${2:-$(sed -n '1s/^# generation://p' "$root/active.conf")}
case "$generation" in *[!0-9a-f]*|'') echo "Invalid Dovecot generation" >&2; exit 1;; esac
[ "${#generation}" -eq 32 ]
directory="$root/generations/$generation"
[ -d "$directory" ] && [ ! -L "$directory" ]

case "$action" in
  prepare)
    writer_uid=$(stat -c %u "$root")
    case "${VEXLYX_SEED_DEV_FIXTURES:-false}" in
      false) /usr/local/bin/users-security.sh check "$directory/users" ;;
      true) ;;
      *) echo "Invalid VEXLYX_SEED_DEV_FIXTURES" >&2; exit 1 ;;
    esac
    chgrp dovecot "$root" "$root/generations" "$directory" "$directory/users"
    chmod 750 "$root" "$root/generations" "$directory"
    chmod 640 "$directory/users"
    (cd "$directory"; sha256sum users > .sha256)
    chown "$writer_uid" "$directory" "$directory/users" "$directory/.sha256"
    chgrp dovecot "$directory/.sha256"
    chmod 640 "$directory/.sha256"
    ;;
  activate)
    doveadm reload
    ;;
  health)
    doveadm service status auth >/dev/null
    su -s /bin/sh dovecot -c "cd '$directory' && sha256sum -c .sha256 >/dev/null"
    doveconf -n | grep -F "$directory/users" >/dev/null
    address=$(sed -n '/^[^#][^:]*:/s/:.*//p' "$directory/users" | head -n 1)
    if [ -n "$address" ]; then doveadm user "$address" >/dev/null; fi
    ;;
  *) echo "Unknown Dovecot mail-state action" >&2; exit 1;;
esac
