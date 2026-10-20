# Persistent mail runtime state

Postfix routing maps, compiled LMDB databases, Dovecot users, and OpenDKIM keys/tables are generated runtime data. Production stores them in `/var/lib/vexlyx/mail`, outside the Git checkout. Set `VEXLYX_MAIL_STATE_DIR` in `/etc/vexlyx/vexlyx.env` to choose another dedicated absolute directory. The API mounts the same absolute path; mail containers mount component directories. Development defaults to the ignored `docker/mail-data/state` directory.

Mail messages remain in `docker/mail-data/vhosts`. Migration does not move, delete, or recreate message storage. Back up PostgreSQL, message storage, and the runtime directory together, retaining permissions and private keys.

## Development ownership

Compose runs `mail-state-init` before Postfix or Dovecot. It gives the state
directories and files to the checkout owner's numeric UID (the host development
API user), including directories Docker initially created as root. If the API
runs as another user, set `VEXLYX_MAIL_UID` and `VEXLYX_MAIL_GID` in the Compose
environment to that user's numeric IDs. Production initializes the same external
state directory mounted by the API. Dovecot preparation preserves the writer as
owner, grants its auth group read access, and keeps directories at 0750 and
password files at 0640. Recreate the mail services to repair existing development
state; password files are never made world-readable.

## Upgrading an existing installation

Run the updated public installer **from outside the checkout before pulling the revision that removes tracked maps**. The bootstrap fetches the target migrator, stops the API writer, copies the legacy generated files and DKIM keys into a verified backup, initializes persistent state, and only then restores the backed-up tracked generated files so Git can update. Staged or unrelated source changes stop the upgrade. There is no stash, hard reset, or clean operation.

The backup is in `$VEXLYX_MAIL_STATE_DIR/legacy-backups/<id>/`, with SHA-256 checksums. `.migration.json` records the latest migration. Re-running migration preserves active generations and existing keys. Existing conflicting runtime DKIM files cause the initial migration to fail with both copies preserved. Resolve conflicts against the verified backup before retrying.

For a manual upgrade, stop API writers and run the **new standalone migrator against the old checkout** before updating it:

```sh
python3 /path/to/new/mail_state_migrate.py --source /opt/vexlyx --state-root /var/lib/vexlyx/mail
```

Do not discard dirty legacy map files before migration. If an earlier upgrade already replaced them, recover the backed-up legacy data and reconcile against PostgreSQL. Starting containers with empty development state is not a production migration.

The installer rebuilds both mail images, waits for readiness, reconciles the complete database snapshot, and verifies live configuration. A compilation, reload, mount visibility, or lookup failure stops installation. Resolve the reported failure and rerun; persistent data and verified backups remain available. If pre-upgrade migration fails after stopping the API, correct the error and rerun the installer before resuming writes.

## Synchronization and recovery

`Mail > Synchronize` acquires a cross-process file lock before reading a repeatable-read PostgreSQL snapshot of **all tenants**. Responses contain only the caller's domain names and counts. Routing tables and passwd files are staged in immutable generation directories. Postfix compiles both LMDB maps and verifies their generation markers before activation. Dovecot reloads the new passwd-file without recreating the container; auth caching is disabled so resets apply immediately.

Activation files are atomically replaced through directory mounts. Auth activates before SMTP. A failure restores the previous configurations and reloads both services; `rollbackFailed` identifies services that could not recover. Keep the affected service out of traffic until readiness passes. The current and previous successful generations are retained. This is coordinated activation with rollback, not a distributed transaction across PostgreSQL, Postfix, and Dovecot.

When a mailbox or alias database change succeeds but activation fails, the API returns HTTP 503 with `databaseChanged: true`, a stable error code, and retry guidance. The dashboard refreshes the saved list and displays the error. Correct the service error and use Synchronize. For failed mailbox creation or password reset, reset the password again to receive a new plaintext password; failed requests never expose password hashes.

Readiness verifies the configured generation, hashes of source and compiled files, permissions using the service account, LMDB lookups, and Dovecot user lookup. The API additionally compares the container-visible activation file with the host file to detect old mounts. A listening SMTP/IMAP port alone does not report healthy mail state.

To reconcile and verify from the production API container:

```sh
docker compose --env-file /etc/vexlyx/vexlyx.env -f docker-compose.yml -f docker-compose.prod.yml exec -T api node dist/scripts/sync-mail-state.js
docker compose --env-file /etc/vexlyx/vexlyx.env -f docker-compose.yml -f docker-compose.prod.yml exec -T api python /opt/vexlyx/system/python/postfix_manager.py verify_state
```

If `MAIL_STATE_MOUNT_STALE` is reported, recreate the affected container with the current Compose directory mounts, then synchronize. Do not delete the runtime directory, keys, or message storage. If restoring manually, restore a consistent database/state/message backup and rebuild routing/auth state from PostgreSQL before admitting traffic.

## Regression checks

Failed staging or preparation removes unpublished generations immediately.
After activation starts, failed generations are removed only when configuration
restoration and daemon health confirm rollback succeeded for both services. If
rollback cannot be confirmed, the files are retained because a daemon may still
need them. A later successful synchronization verifies both services before
pruning older generations. `cleanupFailed` reports components whose unused files
could not be removed without hiding the original synchronization error.

`sh tests/mail-state/run.sh` builds isolated mail images and runs Linux unit tests plus live SMTP, authentication, migration, stale map, compilation failure, and container recreation tests. It creates a disposable `vexlyx-issue36-*` volume/network, publishes no host ports, and removes its resources afterward. The CI `mail-state` job runs this suite. API unit tests cover lock/snapshot ordering, tenant preservation, subprocess failures, timeout recovery, authentication, and partial-failure responses.
