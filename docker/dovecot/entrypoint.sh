#!/bin/sh
set -e

echo "[Vexlyx] Initializing Dovecot IMAP Server..."

# Seeding must be explicitly enabled. A typo must not enable known credentials.
case "${VEXLYX_SEED_DEV_FIXTURES:-false}" in
    true|false) ;;
    *) echo "[Vexlyx] VEXLYX_SEED_DEV_FIXTURES must be true or false." >&2; exit 1 ;;
esac

# 1. TLS Certificates
mkdir -p /etc/dovecot/certs
if [ ! -f /etc/dovecot/certs/cert.pem ] || [ ! -f /etc/dovecot/certs/key.pem ]; then
    echo "[Vexlyx] Generating self-signed TLS certificates..."
    openssl req -new -newkey rsa:2048 -days 365 -nodes -x509 \
        -subj "/C=US/ST=State/L=City/O=Vexlyx/CN=${MYHOSTNAME:-mail.vexlyx.local}" \
        -keyout /etc/dovecot/certs/key.pem -out /etc/dovecot/certs/cert.pem
    chmod 600 /etc/dovecot/certs/key.pem
    chmod 644 /etc/dovecot/certs/cert.pem
fi

# 2. Virtual mailbox base directory (shared with Postfix via bind mount)
# Fixed uid:gid 5000:5000 must match mail_uid/mail_gid in dovecot.conf and
# virtual_uid_maps/virtual_gid_maps in Postfix's main.cf.
mkdir -p /var/mail/vhosts
chown -R 5000:5000 /var/mail/vhosts 2>/dev/null || true

# Index cache directory — container-local (not bind-mounted), see the
# INDEX= comment in dovecot.conf for why.
mkdir -p /var/indexes
chown -R 5000:5000 /var/indexes 2>/dev/null || true

state=/var/lib/vexlyx-mail/dovecot
mkdir -p "$state/generations"
if [ ! -f "$state/active.conf" ]; then
    generation=$(openssl rand -hex 16)
    directory="$state/generations/$generation"
    mkdir -p "$directory"
    touch "$directory/users"
    cat > "$state/active.conf" <<EOF
# generation:$generation
passdb {
  driver = passwd-file
  args = scheme=ARGON2ID username_format=%u $directory/users
}
userdb {
  driver = passwd-file
  args = username_format=%u $directory/users
}
EOF
fi
generation=$(sed -n '1s/^# generation://p' "$state/active.conf")
case "$generation" in *[!0-9a-f]*|'') echo "Invalid Dovecot generation" >&2; exit 1;; esac
[ "${#generation}" -eq 32 ]
users="$state/generations/$generation/users"
if [ -L "$users" ] || [ ! -f "$users" ]; then
    echo "[Vexlyx] Refusing non-regular mailbox users file." >&2
    exit 1
fi
# Repair each explicitly enabled development fixture without resetting existing passwords.
if [ "${VEXLYX_SEED_DEV_FIXTURES:-false}" = true ]; then
    for name in test admin; do
        if ! grep -q "^${name}@vexlyx[.]local:" "$users"; then
            HASH=$(doveadm -c /dev/null pw -s ARGON2ID -p "vexlyx-dev")
            mkdir -p "/var/mail/vhosts/vexlyx.local/$name/Maildir/cur" "/var/mail/vhosts/vexlyx.local/$name/Maildir/new" "/var/mail/vhosts/vexlyx.local/$name/Maildir/tmp"
            chown -R 5000:5000 "/var/mail/vhosts/vexlyx.local/$name"
            printf '\n%s\n' "$name@vexlyx.local:${HASH}:5000:5000::::userdb_quota_rule=*:storage=1024M" >> "$users"
        fi
    done
fi
/usr/local/bin/mail-state.sh prepare "$generation"

echo "[Vexlyx] Starting Dovecot IMAP on ports 143 and 993 (SASL auth on 12345)..."
exec dovecot -F -c /etc/dovecot/dovecot.conf
