# Developer reference

These pages explain how Vexlyx is built, tested, and extended. Their sources live in `docs/dev/`
next to the code so implementation changes and engineering documentation can be reviewed together.

::: tip Looking for step-by-step user guides?
Use [Getting started](/guide/getting-started) and the [feature guide](/guide/features). For HTTP
endpoint documentation and API conventions, see the [API reference](/api/).
:::

## Sections

| Section | What it covers |
|---|---|
| [Foundation](/reference/monorepo) | The monorepo, API and dashboard setup, database, shared schemas, infrastructure |
| [Access and security](/reference/authentication) | Sign-in, roles, fine-grained permissions, reseller quotas, the audit log |
| [Projects and deployment](/reference/projects-api) | Projects, Git, webhooks, builds, the deployment engine, live logs, environment variables |
| [Runtimes](/reference/runtimes/nextjs) | Next.js, Python, React and Vite, PHP and WordPress, custom Dockerfiles |
| [Domains, DNS and SSL](/reference/domains) | Domains, subdomains, DNS zones, routing, certificates |
| [Email](/reference/email/postfix) | Postfix, Dovecot, mailboxes, webmail, SPF, DKIM and DMARC, aliases, mail operations |
| [Databases and files](/reference/database-provisioning) | MySQL and PostgreSQL provisioning, the file manager and SFTP |
| [Operations](/reference/installer) | The installer, monitoring, backups, firewall, service status, cleanup |

## About these pages

- They are generated from `docs/dev/` in the
  [Vexlyx repository](https://github.com/atlantiqshq/vexlyx/tree/main/docs/dev). To fix
  something, use the **Edit this page** link at the bottom of any page; it opens the source file.
- Some pages mention feature codes such as F3.1. They match the roadmap in the repository's
  `FEATURES.md`.
