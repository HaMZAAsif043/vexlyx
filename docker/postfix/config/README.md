Generated mail maps live under `VEXLYX_MAIL_STATE_DIR`, not in this checkout.
Production defaults to `/var/lib/vexlyx/mail`; development uses the ignored
`docker/mail-data/state` directory. Run `system/python/mail_state_migrate.py`
before upgrading a legacy installation. See `docs/dev/email/mail-state.md`.
