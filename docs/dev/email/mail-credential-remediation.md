# Remove exposed development mail credentials

Older checkouts tracked `docker/dovecot/config/users`, including two mailboxes
with the public development password. Disabling fixture seeding did not disable
those existing accounts. Treat those credentials as compromised.

## Before upgrading an existing deployment

Schedule a mail maintenance window and back up PostgreSQL and message storage.
Run the new standalone migrator against the old checkout **before pulling or
checking out the fix**. Git removes tracked Postfix maps and OpenDKIM tables as
well as the old users file; backing up only users is insufficient.

Keep mail services and API writers stopped throughout the upgrade. Set
`MAIL_STATE_DIR` below to the same `VEXLYX_MAIL_STATE_DIR` configured in
`/etc/vexlyx/vexlyx.env`. Run from the existing checkout:

```sh
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml stop api roundcube postfix dovecot
MAIL_STATE_DIR=/var/lib/vexlyx/mail
git fetch origin main
MAIL_MIGRATOR=$(mktemp)
git show FETCH_HEAD:system/python/mail_state_migrate.py > "$MAIL_MIGRATOR"
sudo python3 "$MAIL_MIGRATOR" --source "$PWD" --state-root "$MAIL_STATE_DIR"
rm -f "$MAIL_MIGRATOR"
```

Stop here if migration fails. Do not restore or update tracked files until it
succeeds. Migration copies all three Postfix maps, the Dovecot users file, and
OpenDKIM tables and private keys. It verifies backup checksums and initializes
the active runtime generations. Its result reports the backup directory, also
recorded in `$MAIL_STATE_DIR/.migration.json`. Existing Maildirs stay in place.

Preserve staged or unrelated source edits separately. After verifying the
migration backup, restore only the backed-up, tracked runtime files so dirty
generated maps do not block the update:

```sh
git diff --cached --quiet || { echo "Preserve staged changes before upgrading" >&2; exit 1; }
for file in \
  docker/postfix/config/virtual_domains \
  docker/postfix/config/virtual_mailbox_maps \
  docker/postfix/config/virtual_alias_maps \
  docker/dovecot/config/users \
  docker/postfix/opendkim/KeyTable \
  docker/postfix/opendkim/SigningTable \
  docker/postfix/opendkim/TrustedHosts; do
  if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
    git restore --worktree -- "$file" || exit 1
  fi
done
git merge --ff-only FETCH_HEAD
```

Stop if the merge fails; do not discard source edits to force it through. For a
release-tag upgrade, fetch that exact tag instead of main and use the same
FETCH_HEAD throughout migration and checkout. The updated installer performs
these preservation checks automatically when run from outside the checkout.
Do not copy backup credentials into tickets or logs.

## Remediate and restart

The new production entrypoint refuses to start when it detects the published
salt/digest under any mailbox address or the public development password on
`test@vexlyx.local` / `admin@vexlyx.local`, including hashes with different salts.
It does not automatically delete accounts. Unknown fixture hash encodings also
block startup until the operator reviews and rotates them.

```sh
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml build dovecot postfix
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
  --entrypoint /usr/local/bin/users-security.sh dovecot remediate
```

The command first validates the entire file, then creates a mode-0600 backup
alongside it and atomically publishes a cleaned file. It removes only detected
exposed credentials and preserves unrelated mailboxes, including fixture
addresses whose passwords have been rotated. It does not delete Maildirs or
messages. A validation or backup failure leaves the original file active.
Backups stay outside the image build context and Git tracking. Move them to your
protected backup storage after remediation, following your retention policy.

If these accounts exist in the panel's mailbox database, remove them or rotate
their passwords there **before the next mailbox synchronization**, so the database
cannot restore the exposed credentials. Rotate the development password anywhere
else it was reused. Restoring the original users backup would restore the
vulnerability; remediate restored backups before restarting production.

```sh
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --wait dovecot postfix api
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml exec -T api node dist/scripts/sync-mail-state.js
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml exec -T api python /opt/vexlyx/system/python/postfix_manager.py verify_state
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml up -d roundcube
```

Rebuild the API through the normal installer/build procedure before this restart.
Do not admit mail traffic until reconciliation and verification succeed.

Confirm the exposed credentials fail IMAP and SMTP AUTH, and verify a legitimate
mailbox can log in and send/receive mail. Review available authentication and mail
logs for possible misuse; removing credentials cannot undo prior access.

## Fresh deployments and development

The container creates its runtime `users` file with mode 0640, readable by the
Dovecot auth worker. Both passdb and userdb use the generation selected in
`/var/lib/vexlyx-mail/dovecot/active.conf`. The remediation command resolves that
active generation automatically. Production host state is stored under
`VEXLYX_MAIL_STATE_DIR` (normally `/var/lib/vexlyx/mail`); use that same directory
for the migration command above if your deployment customizes it. Every staged
generation is checked before activation, so synchronization cannot restore an
exposed credential in production.

Seeding defaults to disabled in the image. Base development Compose explicitly
sets `VEXLYX_SEED_DEV_FIXTURES: "true"`; the production overlay overrides it with
`"false"`. Invalid values abort startup. Development creates each missing fixture
independently and does not replace existing passwords. Changing a development
volume to production requires the same offline remediation above.

## Regression checks

```sh
docker build -t vexlyx-dovecot:credentials-test docker/dovecot
docker build -t vexlyx-postfix:credentials-test docker/postfix
python -m unittest tests.test_mail_credential_security tests.test_mail_credential_protocols -v
```

These tests use disposable containers, private networks, and volumes. They cover
startup rejection, offline cleanup and failure handling, build-context exclusions,
IMAP/SMTP authentication, and legitimate local mail delivery. CI runs the same
checks in the `mail-credential-security` job.

For the Roundcube browser regression, with Playwright and Chromium installed:

```sh
python -m tests.test_mail_credential_protocols --keep
node tests/mail-credential-browser.cjs
python -m tests.test_mail_credential_protocols --cleanup
```

The browser test verifies both exposed logins fail and a legitimate mailbox
reaches Inbox. It uses only the isolated stack's loopback URL. If using an
external Playwright runtime or an installed browser, set
`VEXLYX_PLAYWRIGHT_MODULE` and `VEXLYX_BROWSER_EXECUTABLE` to their paths.
