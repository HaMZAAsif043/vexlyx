#!/usr/bin/env bash
# Offline passwd-file validation/remediation. Never print hashes or passwords.
set -euo pipefail
umask 077

action=${1:-check}
if [[ -n "${2:-}" ]]; then
    users=$2
else
    root=/var/lib/vexlyx-mail/dovecot
    generation=$(sed -n '1s/^# generation://p' "$root/active.conf")
    [[ "$generation" =~ ^[0-9a-f]{32}$ ]] || { echo "Invalid Dovecot generation" >&2; exit 1; }
    users="$root/generations/$generation/users"
fi
case "$action" in
    check|remediate) ;;
    *) echo "Usage: users-security.sh check|remediate [users-file]" >&2; exit 2 ;;
esac
if [[ ! -f "$users" || -L "$users" ]]; then
    echo "[Vexlyx] Mailbox users file must be a regular, non-symlink file." >&2
    exit 1
fi
if [[ "$action" = remediate ]] && pidof dovecot >/dev/null; then
    echo "[Vexlyx] Stop mail services before offline remediation." >&2
    exit 1
fi

# Identify the published credential by its salt/digest: parameter
# ordering or a missing scheme prefix must not bypass the revoked credential.
published_salt='U+cApES5CNwhZn7jxTvr0w'
published_digest='c/Fm2zGrJFBvSQ8IsnQk1oJmS+TsCZOGPOzXc0iIUoE'
verified=false
unsafe=0
temporary=
backup=
trap '[[ -z "$temporary" ]] || rm -f -- "$temporary"' EXIT
if [[ "$action" = remediate ]]; then
    temporary=$(mktemp "${users}.clean.XXXXXX")
fi

while IFS= read -r line || [[ -n "$line" ]]; do
    # CRLF occurs on older Windows-hosted installations.
    record=${line%$'\r'}
    address=${record%%:*}
    rest=${record#*:}
    hash=${rest%%:*}
    compromised=false
    if [[ "$hash" = *"\$$published_salt\$$published_digest" ]]; then
        compromised=true
    elif [[ "${address,,}" = test@vexlyx.local || "${address,,}" = admin@vexlyx.local ]]; then
        # Exercise the verifier first. An unavailable Argon2 implementation must
        # never be mistaken for a password mismatch on these reserved fixtures.
        if [[ "$verified" = false ]]; then
            probe=$(doveadm -c /dev/null pw -s ARGON2ID -p vexlyx-dev)
            doveadm -c /dev/null pw -t "$probe" -p vexlyx-dev >/dev/null 2>&1
            verified=true
        fi
        # These fixtures historically use Argon2id. Unknown encodings require
        # operator review, rather than treating a verifier error as safe.
        encoded=${hash#\{ARGON2ID\}}
        if [[ ! "$encoded" =~ ^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$ ]]; then
            echo "[Vexlyx] Unverifiable fixture credential; rotate it before production startup." >&2
            exit 1
        fi
        if doveadm -c /dev/null pw -t "{ARGON2ID}$encoded" -p vexlyx-dev >/dev/null 2>&1; then
            compromised=true
        else
            result=$?
            if [[ "$result" != 75 ]]; then
                echo "[Vexlyx] Fixture password verification failed unexpectedly." >&2
                exit 1
            fi
        fi
    fi
    if [[ "$compromised" = true ]]; then
        unsafe=$((unsafe + 1))
    elif [[ "$action" = remediate ]]; then
        printf '%s\n' "$line" >> "$temporary"
    fi
done < "$users"

if [[ "$unsafe" = 0 ]]; then
    echo "[Vexlyx] No exposed fixture credentials found."
    exit 0
fi
if [[ "$action" = check ]]; then
    echo "[Vexlyx] Refusing production startup: $unsafe exposed fixture credential(s)." >&2
    echo "[Vexlyx] Stop mail services and follow docs/dev/email/mail-credential-remediation.md." >&2
    exit 1
fi

# Write the backup before publishing. Same-directory rename is atomic because
# Compose mounts the directory, not the individual users inode.
backup=$(mktemp "${users}.before-remediation.XXXXXX")
cat -- "$users" > "$backup"
chmod 600 "$backup"
chown root:dovecot "$temporary"
chmod 640 "$temporary"
mv -f -- "$temporary" "$users"
temporary=
echo "[Vexlyx] Removed $unsafe exposed credential(s); backup: $backup"
