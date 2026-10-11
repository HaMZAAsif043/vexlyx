# Docker deployment

Vexlyx uses Docker Compose for its production services, but the supported production entry point is the Ubuntu installer. The installer prepares the host, renders secrets and production overrides, runs migrations, configures the firewall, and starts the Compose stack. Running `docker compose up` against a fresh clone does not perform those host-level steps.

## Supported production deployment

Install on Ubuntu 24.04 using the [installation guide](/guide/installation). After installation, the production stack is managed from `/opt/vexlyx`:

```bash
cd /opt/vexlyx
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml ps
```

Use the same file set for logs and service inspection:

```bash
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml logs --tail=200 api
```

Do not copy `/etc/vexlyx/vexlyx.env` into the repository or attach it to an issue.

## Development deployment

For local development, bootstrap the repository instead of using the production override:

```bash
corepack enable
pnpm bootstrap
pnpm dev
```

The default Compose file starts supporting infrastructure. The dashboard and API run in watch mode on the host. Use `pnpm bootstrap --full` only when working on the complete mail, DNS, MySQL, webmail, or Adminer stack.

## Custom container platforms

Kubernetes, Docker Swarm, Portainer stacks, and hand-authored production Compose deployments are not currently supported installation targets. Vexlyx performs host operations through its Python system layer and expects the filesystem paths, Docker network, firewall rules, certificates, and secrets created by the installer. Porting only the application containers will leave deployment, DNS, mail, backups, or firewall management incomplete.

If you maintain a custom deployment, treat the [installer reference](/reference/installer), [infrastructure reference](/reference/infrastructure), and production Compose files as the contract. You are responsible for upgrades, secret generation, persistent volumes, host permissions, health checks, network isolation, and disaster recovery.

## Container health

Run `docker compose ... ps` and confirm required services are healthy. If a service is restarting or unhealthy:

1. Inspect its recent logs.
2. Confirm required secrets and mounted files exist.
3. Check host disk space and port conflicts.
4. Rerun the installer to repair managed configuration.
5. Use [Troubleshooting](/guide/troubleshooting) before deleting containers or volumes.
