# Feature guide

Use this page to find the right user guide or technical reference. Availability can depend on the Vexlyx version and the permissions assigned to your account.

## Applications and deployments

| Capability | Start here | Technical detail |
|---|---|---|
| Projects and deployment | [Deploying a project](/guide/deploying) | [Projects API](/reference/projects-api) |
| GitHub connection and automatic deploys | [Connect a repository](/guide/deploying#connect-a-repository) | [GitHub integration](/reference/github-integration) |
| Manual Git providers and deploy keys | [Connect a repository](/guide/deploying#connect-a-repository) | [Git integration](/reference/git-integration) |
| Environment variables | [Environment variables](/guide/deploying#environment-variables) | [Environment variable security](/reference/environment-variables) |
| Build and runtime logs | [Watching logs](/guide/deploying#watching-logs) | [Real-time logs](/reference/realtime-logs) |
| Next.js, Python, React, PHP, WordPress, and Docker | [Runtime requirements](/guide/deploying#per-type-notes) | [Runtime reference](/reference/runtimes/nextjs) |
| File manager and SFTP | [File manager reference](/reference/file-manager-sftp) | [File manager and SFTP](/reference/file-manager-sftp) |

## Domains, data, and communication

| Capability | Start here | Technical detail |
|---|---|---|
| Domains, subdomains, DNS, and TLS | [Domains and SSL](/guide/domains-and-ssl) | [Domain management](/reference/domains) |
| PostgreSQL and MySQL databases | [Database provisioning](/reference/database-provisioning) | [Database architecture](/reference/database) |
| Mailboxes and webmail | [Email](/guide/email) | [Mail architecture](/reference/email/postfix) |
| Forwarding, aliases, and vacation replies | [Email](/guide/email) | [Aliases](/reference/email/aliases) |

## Administration and security

| Capability | Start here | Technical detail |
|---|---|---|
| Monitoring and service health | [Operations](/guide/operations) | [Monitoring](/reference/monitoring) |
| Backups and restore | [Operations](/guide/operations) | [Backup system](/reference/backup-system) |
| Firewall and disk cleanup | [Operations](/guide/operations) | [Firewall](/reference/firewall) |
| Users, resellers, quotas, and permissions | [Operations](/guide/operations) | [Roles and permissions](/reference/roles-permissions) |
| Two-factor authentication | [Operations](/guide/operations) | [Two-factor authentication](/reference/two-factor-auth) |
| Audit events | [Operations](/guide/operations) | [Audit log](/reference/audit-log) |
| Panel settings and transactional email | [Operations](/guide/operations) | [Settings](/reference/settings-page) |

## Documentation status

Vexlyx is under active development. The user guides describe supported workflows; the developer reference explains implemented internals and may include version-specific design decisions. Planned work remains in the repository roadmap and is not presented here as available functionality.

## Released-feature coverage

This matrix maps every completed roadmap feature to its primary maintained document. Small UX and reliability features are documented with the subsystem they modify instead of receiving isolated pages.

| Roadmap feature | Primary documentation |
|---|---|
| F0.1 Monorepo setup | [Monorepo](/reference/monorepo) |
| F0.2 Dashboard scaffold | [Dashboard setup](/reference/dashboard-setup) |
| F0.3 Fastify API scaffold | [API setup](/reference/api-setup) |
| F0.4 Prisma schema and database | [Database](/reference/database) |
| F0.5 Redis and Docker Compose | [Infrastructure](/reference/infrastructure) |
| F0.6 Authentication | [Authentication](/reference/authentication) |
| F0.7 Shared types and schemas | [Shared package](/reference/shared-package) |
| F1.1 Project API | [Projects API](/reference/projects-api) |
| F1.2 Project dashboard | [Projects UI](/reference/projects-ui) |
| F1.3 Git integration | [Git integration](/reference/git-integration) |
| F1.4 Build integration | [Build system](/reference/build-system) |
| F1.5 Deployment engine | [Deployment engine](/reference/deployment-engine) |
| F1.6 Real-time logs | [Real-time logs](/reference/realtime-logs) |
| F1.7 Environment variables | [Environment variables](/reference/environment-variables) |
| F1.8 Project details | [Project detail page](/reference/project-detail-page) |
| F2.1–F2.5 Application runtimes | [Deploying a project](/guide/deploying#per-type-notes) |
| F2.6 Database provisioning | [Database provisioning](/reference/database-provisioning) |
| F2.7 GitHub webhooks | [GitHub webhooks](/reference/github-webhooks) |
| F2.8 File manager and SFTP | [File manager and SFTP](/reference/file-manager-sftp) |
| F3.1–F3.5 Domains, DNS, SSL, and UX | [Domains, subdomains and SSL](/guide/domains-and-ssl) |
| F4.1–F4.8 Email hosting and operations | [Email](/guide/email) |
| F5.1 Installer | [Installation](/guide/installation) |
| F5.2 and F5.13 Monitoring | [Monitoring](/reference/monitoring) |
| F5.3 and F5.14 Backups | [Backup system](/reference/backup-system) |
| F5.4 Firewall | [Firewall](/reference/firewall) |
| F5.5, F5.8, F5.19, and F5.20 Users and permissions | [Roles and permissions](/reference/roles-permissions) |
| F5.6 Service status | [Service status](/reference/service-status) |
| F5.7 and F5.21 No-build hosting | [Fast static and WordPress serving](/reference/fast-static-wordpress-serving) |
| F5.9, F5.22, F5.25, and F5.27 DNS onboarding and modes | [DNS onboarding](/reference/dns-onboarding) |
| F5.10 Production routing | [Domain routing](/reference/domain-routing) |
| F5.11 Settings | [Settings page](/reference/settings-page) |
| F5.12 Design-system consistency | [Design system](/reference/design-system) |
| F5.15 Docker cleanup | [Docker cleanup](/reference/docker-cleanup) |
| F5.16 Dashboard widgets | [Dashboard home](/reference/dashboard-home) |
| F5.17 Two-factor authentication | [Two-factor authentication](/reference/two-factor-auth) |
| F5.18 Audit log | [Audit log](/reference/audit-log) |
| F5.23 Transactional email | [System transactional email](/reference/system-transactional-email) |
| F5.24 File permissions and archives | [File manager and SFTP](/reference/file-manager-sftp) |
| F5.26 Mail authentication for connected domains | [Email authentication](/reference/email/authentication) |
| F5.29 GitHub integration | [GitHub integration](/reference/github-integration) |
| F6.2 CI/CD | [CI/CD](/reference/ci-cd) |

F5.28 scheduled tasks and F6.3 community infrastructure are excluded because the roadmap marks them as not started.

If a documented workflow does not match the current release, report it through the [issue tracker](https://github.com/atlantiqshq/vexlyx/issues) and include the Vexlyx version, installation method, and relevant logs with secrets removed.
