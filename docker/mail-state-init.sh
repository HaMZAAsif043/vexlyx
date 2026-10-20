#!/bin/sh
set -eu

root=/state
writer_uid=${VEXLYX_MAIL_UID:-$(stat -c %u /source)}
writer_gid=${VEXLYX_MAIL_GID:-$(stat -c %g /source)}
case "$writer_uid" in ''|*[!0-9]*) echo "Invalid mail writer UID" >&2; exit 1;; esac
case "$writer_gid" in ''|*[!0-9]*) echo "Invalid mail writer GID" >&2; exit 1;; esac

# Password files must remain private; only the API owner and Dovecot may read them.
for component in postfix dovecot; do
    if [ -L "$root/$component" ] || find "$root/$component" -type l -print 2>/dev/null | grep -q .; then
        echo "Refusing symlinked mail state" >&2
        exit 1
    fi
done
if [ -L "$root/.sync.lock" ]; then
    echo "Refusing symlinked mail lock" >&2
    exit 1
fi
chown "$writer_uid:$writer_gid" "$root"
chmod 750 "$root"
if [ -f "$root/.sync.lock" ]; then chown "$writer_uid:$writer_gid" "$root/.sync.lock"; fi
for component in postfix dovecot; do
    mkdir -p "$root/$component/generations"
    find "$root/$component" -exec chown "$writer_uid" {} +
    if [ "$component" = dovecot ]; then
        find "$root/$component" -type d -exec chmod 750 {} +
        find "$root/$component" -type f \( -name users -o -name .sha256 \) -exec chmod 640 {} +
    else
        find "$root/$component" -type d -exec chmod 755 {} +
    fi
done
