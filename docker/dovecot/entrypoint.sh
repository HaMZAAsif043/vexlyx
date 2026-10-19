#!/bin/sh
set -e

echo "[Vexlyx] Initializing Dovecot IMAP Server..."

# Seeding must be explicitly enabled. A typo must not enable known credentials.
case "${VEXLYX_SEED_DEV_FIXTURES:-false}" in
    true|false) ;;
    *) echo "[Vexlyx] VEXLYX_SEED_DEV_FIXTURES must be true or false." >&2; exit 1 ;;
esac

users=/etc/dovecot/virtual/users
# The auth worker reads the runtime passwd-file through its dovecot group.
mkdir -p /etc/dovecot/virtual
if [ -L "$users" ] || { [ -e "$users" ] && [ ! -f "$users" ]; }; then
    echo "[Vexlyx] Refusing non-regular mailbox users file." >&2
    exit 1
fi
(umask 027; touch "$users")
chown root:dovecot "$users"
chmod 640 "$users"
if [ "${VEXLYX_SEED_DEV_FIXTURES:-false}" = false ]; then
    /usr/local/bin/users-security.sh check "$users"
fi

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

# Each fixture is independent so partial development state is repaired safely.
if [ "${VEXLYX_SEED_DEV_FIXTURES:-false}" = true ]; then
    for name in test admin; do
        if ! grep -q "^${name}@vexlyx[.]local:" "$users"; then
            HASH=$(doveadm -c /dev/null pw -s ARGON2ID -p "vexlyx-dev")
            mkdir -p "/var/mail/vhosts/vexlyx.local/$name/Maildir/cur" "/var/mail/vhosts/vexlyx.local/$name/Maildir/new" "/var/mail/vhosts/vexlyx.local/$name/Maildir/tmp"
            chown -R 5000:5000 "/var/mail/vhosts/vexlyx.local/$name"
            # Append a separator as an existing passwd-file may lack a final LF.
            printf '\n%s\n' "$name@vexlyx.local:${HASH}:5000:5000::::userdb_quota_rule=*:storage=1024M" >> "$users"
        fi
    done
fi

echo "[Vexlyx] Starting Dovecot IMAP on ports 143 and 993 (SASL auth on 12345)..."
exec dovecot -F -c /etc/dovecot/dovecot.conf
