# Remove exposed development mail credentials

Older checkouts tracked `docker/dovecot/config/users`, including two mailboxes
with the public development password. Disabling fixture seeding did not disable
those existing accounts. Treat those credentials as compromised.

## Before upgrading an existing deployment

Schedule a mail maintenance window. Run these commands from the existing
checkout **before pulling/checking out the fix**: Git may delete the formerly
tracked file during the upgrade. Use your normal production Compose environment.

```sh
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml stop api roundcube postfix dovecot
sudo install -d -m 0700 /etc/vexlyx/mail-backups
MAIL_USERS_BACKUP=$(sudo mktemp /etc/vexlyx/mail-backups/users.XXXXXX)
sudo install -m 0600 docker/dovecot/config/users "$MAIL_USERS_BACKUP"
printf 'Mailbox users backup: %s\n' "$MAIL_USERS_BACKUP"
```

Record the backup filename. Keep mail services and mailbox provisioning stopped
throughout the procedure; do not allow another process to rewrite the users file.

The panel rewrites that tracked file whenever mailboxes change, so on a running
server Git sees it as modified and **refuses to update** ("Please commit your
changes or stash them"). The installer behaves the same way: it leaves a checkout
with local changes alone, so re-running `install.sh` will not upgrade it. With the
backup safely taken, discard the local change and update the checkout (use
`git pull`, not the installer, so mail services are not started before the
remediation below):

```sh
git checkout -- docker/dovecot/config/users
git pull --ff-only origin main   # or: git fetch origin tag vX.Y.Z && git checkout vX.Y.Z
```

The file is no longer tracked after this update, so Git leaves it alone from now on.
Restore the backup (set `MAIL_USERS_BACKUP` to the recorded filename if using a new
shell):

```sh
sudo install -m 0600 "$MAIL_USERS_BACKUP" docker/dovecot/config/users
```

Do not copy backup credentials into tickets or logs. Back up the mailbox
database using your normal database backup procedure too.

## Remediate and restart

The new production entrypoint refuses to start when it detects the published
salt/digest under any mailbox address or the public development password on
`test@vexlyx.local` / `admin@vexlyx.local`, including hashes with different salts.
It does not automatically delete accounts. Unknown fixture hash encodings also
block startup until the operator reviews and rotates them.

```sh
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml build dovecot
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
  -f docker-compose.yml -f docker-compose.prod.yml up -d dovecot postfix roundcube api
```

Confirm the exposed credentials fail IMAP and SMTP AUTH, and verify a legitimate
mailbox can log in and send/receive mail. Review available authentication and mail
logs for possible misuse; removing credentials cannot undo prior access.

## Fresh deployments and development

A fresh checkout contains only an empty configuration directory placeholder.
The container creates its runtime `users` file with mode 0640, readable by the
Dovecot auth worker. Both passdb and userdb use `/etc/dovecot/virtual/users`.
The host path used by mailbox synchronization remains unchanged.

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
