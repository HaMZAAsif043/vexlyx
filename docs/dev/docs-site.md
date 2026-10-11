# Docs Site — Developer Guide

## Overview

The documentation site at `docs.vexlyx.atlantiqs.org` is a [VitePress](https://vitepress.dev) app that lives in `docs/` of this repository, so docs and code are edited, reviewed and released together. It is a standalone pnpm project (own `package.json` and `pnpm-lock.yaml`), deliberately **not** part of the root pnpm workspace, so installing or building the panel never touches VitePress.

The information architecture separates learning-oriented guides, task-oriented how-to material,
technical reference, and explanation. User guides should help readers reach an outcome; developer
reference should document exact contracts, architecture, tests, and extension points. Roadmap work
must not be presented as released behavior.

## Where content lives

| Site section | Source | Notes |
| --- | --- | --- |
| Developer reference (`/reference/...`) | `docs/dev/**/*.md` | Engineering sources required by `CLAUDE.md`. |
| API (`/api/...`) | `docs/api/` | API conventions and generated-reference entry point. |
| Project (`/project/...`) | `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` at the repo root | Community and release information. |
| Guides (`/guide/...`), home page | `docs/guide/`, `docs/index.md` | Outcome-oriented user and operator documentation. |
| Reference overview | `docs/reference/index.md` | The only committed file in `docs/reference/`. |
| Site config, sidebar, theme | `docs/.vitepress/` | New `docs/dev` pages show up under "More" until you place them in `sidebar.mts`. |

`docs/reference/` (except `index.md`) and `docs/project/` are **generated** by `docs/scripts/sync-docs.mjs` on every `pnpm dev` and `pnpm build`, and are git-ignored. Never edit them; every page's "Edit this page" link goes to the real source. The script rewrites links so the build has no dead ones: links between docs become site links, links to source files become GitHub links, and links to files that do not exist are turned into plain text and printed as warnings. It also strips the internal status blockquote that follows the H1 in most `docs/dev` pages.

## Working on the docs

```bash
cd docs
pnpm install
pnpm dev      # regenerates the reference pages, then serves http://localhost:5173
pnpm build    # same, then builds to docs/.vitepress/dist (fails on dead links)
```

Markdown rules for the site: raw HTML is shown as text and `{{ }}` is not interpreted, so use Markdown only (containers such as `::: tip` work).

## CI and deployment

- `.github/workflows/docs.yml` builds the site on pull requests and pushes that touch `docs/`, `CONTRIBUTING.md`, `SECURITY.md`, or `CHANGELOG.md`.
- Vercel deploys `main` from this repository. Project settings: **Root Directory** `docs`, **Include source files outside of the Root Directory** enabled (the build reads `../docs/dev` and the root markdown files), framework preset VitePress, Install Command `pnpm install`, Build Command `pnpm build`, Output Directory `.vitepress/dist`, and an **Ignored Build Step** so unrelated commits do not redeploy: `git diff --quiet HEAD^ HEAD -- . ../docs ../CONTRIBUTING.md ../SECURITY.md`.

## History

The site used to live in a separate private repository (`vexlyx-docs`) that copied `docs/dev` with a manual `pnpm sync-docs`, which let the published reference drift behind the code. It was merged into this repository so there is a single source of truth.
