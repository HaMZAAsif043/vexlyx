#!/bin/sh
set -e

echo "[Vexlyx] Initializing Postfix SMTP & OpenDKIM..."

# 0. Production hostname override (F5.1) — falls back to the baked-in
# main.cf defaults (mail.vexlyx.local) when unset, so dev is unaffected.
if [ -n "$MYHOSTNAME" ]; then
    postconf -e "myhostname = $MYHOSTNAME"
fi
if [ -n "$MYDOMAIN" ]; then
    postconf -e "mydomain = $MYDOMAIN"
fi

# 1. TLS Certificates
mkdir -p /etc/postfix/certs
if [ ! -f /etc/postfix/certs/cert.pem ] || [ ! -f /etc/postfix/certs/key.pem ]; then
    echo "[Vexlyx] Generating self-signed TLS certificates..."
    openssl req -new -newkey rsa:2048 -days 365 -nodes -x509 \
        -subj "/C=US/ST=State/L=City/O=Vexlyx/CN=${MYHOSTNAME:-mail.vexlyx.local}" \
        -keyout /etc/postfix/certs/key.pem -out /etc/postfix/certs/cert.pem
    chmod 600 /etc/postfix/certs/key.pem
    chmod 644 /etc/postfix/certs/cert.pem
fi

# Runtime state is a directory mount; only the activation file is replaced.
state=/var/lib/vexlyx-mail/postfix
mkdir -p "$state/generations" /var/mail/vhosts
if [ ! -f "$state/active.conf" ]; then
    generation=$(openssl rand -hex 16)
    directory="$state/generations/$generation"
    mkdir -p "$directory"
    touch "$directory/virtual_domains" "$directory/virtual_mailbox_maps" "$directory/virtual_alias_maps"
    if [ "${VEXLYX_SEED_DEV_FIXTURES:-false}" = true ]; then
        echo vexlyx.local > "$directory/virtual_domains"
        printf 'test@vexlyx.local vexlyx.local/test/Maildir/\nadmin@vexlyx.local vexlyx.local/admin/Maildir/\n' > "$directory/virtual_mailbox_maps"
    fi
    {
        echo "# generation:$generation"
        echo "virtual_mailbox_domains = $directory/virtual_domains"
        echo "virtual_mailbox_maps = lmdb:$directory/virtual_mailbox_maps"
        echo "virtual_alias_maps = lmdb:$directory/virtual_alias_maps"
    } > "$state/active.conf"
fi
generation=$(sed -n '1s/^# generation://p' "$state/active.conf")
/usr/local/bin/mail-state.sh prepare "$generation"
/usr/local/bin/mail-state.sh configure

# Fix all spool directory ownership (must run as root before postfix starts)
# Without this, Postfix's cleanup daemon fails with: 451 queue file write error
echo "[Vexlyx] Running postfix set-permissions to fix spool directory ownership..."
postfix set-permissions 2>&1 || true

# 3. OpenDKIM Setup
mkdir -p /etc/opendkim/keys
touch /etc/opendkim/KeyTable
touch /etc/opendkim/SigningTable
if [ ! -f /etc/opendkim/TrustedHosts ]; then
    cat <<EOF > /etc/opendkim/TrustedHosts
127.0.0.1
localhost
::1
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
EOF
fi
chown -R opendkim:opendkim /etc/opendkim || true
chmod -R 750 /etc/opendkim || true

# 4. Fix spool directory permissions (Docker volumes on Windows reset ownership)
# The maildrop dir must be owned postfix:postdrop with setgid so postfix can
# write queue files. Without this, Postfix returns: 451 queue file write error
echo "[Vexlyx] Fixing /var/spool/postfix permissions..."
postfix set-permissions 2>/dev/null || true
chown postfix:postdrop /var/spool/postfix/maildrop 2>/dev/null || true
chmod 730 /var/spool/postfix/maildrop 2>/dev/null || true
chmod g+s /var/spool/postfix/maildrop 2>/dev/null || true

# 5. Delivery/Bounce Log File (F4.8). Runs unconditionally on every start,
# not just first-run — bind-mounted host dirs can appear root:root on first
# mount on Windows Docker Desktop (same class of race documented above for
# /var/spool/postfix).
mkdir -p /var/log/postfix
touch /var/log/postfix/postfix.log
chown postfix:postfix /var/log/postfix/postfix.log
chmod 644 /var/log/postfix/postfix.log

# 6. Start OpenDKIM in background
echo "[Vexlyx] Starting OpenDKIM Milter on port 8891..."
opendkim -x /etc/opendkim/opendkim.conf || true

# 5. Start Postfix in foreground
echo "[Vexlyx] Starting Postfix MTA on ports 25 and 587..."
exec postfix start-fg
