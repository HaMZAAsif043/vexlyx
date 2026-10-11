# Install Vexlyx

Vexlyx is self-hosted. The supported production path installs the panel and its Docker services on a fresh Ubuntu server. Use the local Docker Compose path only for development.

## Choose an installation path

| Goal | Use | Support level |
|---|---|---|
| Run a production panel | [Ubuntu server installer](#production-ubuntu-server) | Supported |
| Contribute or evaluate locally | [Local development with Docker](#local-development-with-docker) | Supported for development |
| Build a custom production image or Compose stack | Existing Compose files as a starting point | Advanced; you own upgrades and hardening |

## Production: Ubuntu server

### Requirements

- Ubuntu 24.04 on `x86_64` or `aarch64`
- Root access, or a user with unrestricted `sudo`
- A public IPv4 address
- A domain whose DNS records you can edit
- Inbound ports 80 and 443; mail and authoritative DNS require additional ports

Vexlyx is a control panel for a dedicated server. Do not install it on a machine already running another control panel or a service bound to its required ports.

### 1. Configure DNS

Create an A record for the panel hostname before installation:

```text
panel.example.com  A  203.0.113.10
```

Wait until the record resolves to the server. The installer uses that hostname to obtain a Let's Encrypt certificate. Project wildcard DNS, hosted DNS, and mail records can be configured after the panel is running.

### 2. Review and run the installer

For an interactive installation, download the script before running it:

```bash
curl -fsSL https://vexlyx.atlantiqs.org/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

For unattended installation, provide at least the panel domain and administrator email:

```bash
VEXLYX_DOMAIN=panel.example.com \
VEXLYX_ADMIN_EMAIL=admin@example.com \
  curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
```

::: warning Protect the generated password
If you do not provide `VEXLYX_ADMIN_PASSWORD`, the installer prints a generated password once. Store it in a password manager before closing the terminal.
:::

The installer configures Docker, the application runtimes, PostgreSQL, Redis, Traefik, DNS, mail services, the panel, TLS, and firewall rules. It checks existing state and is safe to run again after a partial failure.

### 3. Verify the installation

Open `https://panel.example.com`, sign in, and confirm that **Settings → Services** reports healthy services. On the server, inspect the production stack with:

```bash
cd /opt/vexlyx
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml ps
```

Keep `/etc/vexlyx/vexlyx.env` private. It contains installation secrets.

### 4. Finish production setup

- Configure wildcard or per-project DNS records.
- Publish SPF, DKIM, and DMARC records before sending production mail.
- Confirm backup storage and run a restore test.
- Enable two-factor authentication for administrator accounts.
- Review firewall rules and expose only the services you use.

See [Domains, subdomains and SSL](/guide/domains-and-ssl), [Email](/guide/email), and [Operations](/guide/operations).

## Local development with Docker

The repository's Compose stack provides dependencies for development; it is not a second production distribution.

```bash
git clone https://github.com/atlantiqshq/vexlyx.git
cd vexlyx
corepack enable
pnpm bootstrap
pnpm dev
```

Open `http://localhost:3000`. See [Local development](/guide/local-development) for prerequisites, seeded accounts, commands, and troubleshooting.

## Upgrades and repairs

Back up the server before upgrading, then rerun the installer with the intended release or branch. Because installation steps are idempotent, the same process also repairs incomplete configuration. Review the [installer reference](/reference/installer) before using advanced environment variables or changing the production Compose topology.

## Uninstalling

Vexlyx does not currently provide a supported one-command uninstaller. Preserve backups and `/etc/vexlyx/vexlyx.env`, then remove services and data only after identifying which volumes contain customer projects, databases, mail, and certificates.
