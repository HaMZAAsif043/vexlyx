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

# 2. Virtual Maps
mkdir -p /etc/postfix
touch /etc/postfix/virtual_domains
touch /etc/postfix/virtual_mailbox_maps
touch /etc/postfix/virtual_alias_maps
# Must not be group/other writable — postfix check rejects 666/664 config files
chmod 640 /etc/postfix/virtual_domains
chmod 640 /etc/postfix/virtual_mailbox_maps
chmod 640 /etc/postfix/virtual_alias_maps
# 3. Virtual Mailbox Base Directory
# Required by Postfix virtual delivery agent (virtual_mailbox_base in main.cf).
# Shared with Dovecot (F4.2) via bind mount — uid:gid 5000:5000 must match
# virtual_uid_maps/virtual_gid_maps above and Dovecot's mail_uid/mail_gid.
mkdir -p /var/mail/vhosts/vexlyx.local/test
chown -R 5000:5000 /var/mail/vhosts 2>/dev/null || true

# Seed a test mailbox so virtual delivery succeeds in dev. Disabled in
# production (F5.1 sets VEXLYX_SEED_DEV_FIXTURES=false) so a fresh install's
# mail routing table isn't pre-populated with fake dev addresses.
if [ "${VEXLYX_SEED_DEV_FIXTURES:-true}" = "true" ] && [ ! -s /etc/postfix/virtual_mailbox_maps ]; then
    echo "test@vexlyx.local vexlyx.local/test/Maildir/" > /etc/postfix/virtual_mailbox_maps
    echo "admin@vexlyx.local vexlyx.local/test/Maildir/" >> /etc/postfix/virtual_mailbox_maps
fi
# postmap drops privileges to the OWNER of the source file before writing. On a
# Linux host the API writes these bind-mounted files as its own non-root uid, so
# postmap then can't create the .lmdb in root-owned /etc/postfix ("open database
# ... Permission denied") and every mailbox lookup fails. Compile a root-owned
# copy and move the result into place instead.
#
# A missing source file means "first boot, nothing to compile yet" and is fine.
# A real compile failure is NOT: Postfix would keep serving a stale (or no) map
# and reject/misroute mail with no trace of why, so it is reported loudly. It
# does not abort startup, since Postfix can still accept and deliver the mail
# the existing maps cover.
compile_map() {
    name="$1"
    if [ ! -f "/etc/postfix/$name" ]; then
        echo "[Vexlyx] $name has no source file yet (first boot) - skipping map build"
        return 0
    fi
    if cp "/etc/postfix/$name" "/tmp/$name" &&
        postmap "lmdb:/tmp/$name" &&
        mv "/tmp/$name.lmdb" "/etc/postfix/$name.lmdb"; then
        status=0
    else
        status=$?
    fi
    rm -f "/tmp/$name"
    if [ "$status" -ne 0 ]; then
        echo "[Vexlyx] ERROR: failed to compile $name (exit $status) - mail routing may be stale or missing until this is fixed" >&2
    fi
    return "$status"
}
MAP_COMPILE_FAILED=0
compile_map virtual_mailbox_maps || MAP_COMPILE_FAILED=1
compile_map virtual_alias_maps || MAP_COMPILE_FAILED=1
# On a Windows Docker Desktop bind mount (gRPC-FUSE/virtiofs), the .lmdb file
# postmap just wrote is sometimes not yet stat-able by the immediately
# following chmod, which then fails silently ("|| true" swallows it) and
# leaves the file root-only. Same class of race postfix_manager.py already
# works around with a settle delay before its own postmap/chmod calls.
sleep 0.3
# postmap (run as root here) writes .lmdb files as root:root mode 640, but
# actual delivery happens in the unprivileged "virtual" service (mail_owner
# postfix:postfix), which then can't read them — every delivery fails with
# "Permission denied" / "mail system configuration error" despite the map
# itself being correct. Must stay world-readable after every recompile.
for name in virtual_mailbox_maps virtual_alias_maps; do
    lmdb="/etc/postfix/$name.lmdb"
    # No source file means first boot: nothing was meant to be built.
    [ -f "/etc/postfix/$name" ] || continue
    if [ ! -f "$lmdb" ]; then
        echo "[Vexlyx] ERROR: $lmdb is missing although $name exists - the map did not build or is not visible yet; deliveries to its recipients will fail" >&2
        MAP_COMPILE_FAILED=1
        continue
    fi
    if ! chmod 644 "$lmdb"; then
        echo "[Vexlyx] ERROR: could not make $lmdb world-readable - deliveries will fail with 'Permission denied'" >&2
        MAP_COMPILE_FAILED=1
    fi
done
if [ "$MAP_COMPILE_FAILED" -ne 0 ]; then
    echo "[Vexlyx] WARNING: one or more Postfix maps failed to compile (see errors above); continuing startup" >&2
fi

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
