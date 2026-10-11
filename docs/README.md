# Vexlyx documentation

Source for [docs.vexlyx.atlantiqs.org](https://docs.vexlyx.atlantiqs.org), built with VitePress.

- `guide/` contains installation, tutorials, task guides, and troubleshooting.
- `api/` is the API entry point and records the current OpenAPI status.
- `dev/` contains engineering sources published under `/reference/`.
- `project/` is generated from repository-level community and release files, except its index.

Do not edit generated files under `reference/` or generated pages under `project/`. Edit their source documents instead.

## Run locally

```bash
cd docs
pnpm install
pnpm dev
```

From the repository root, you can instead run `pnpm --dir docs dev`.

## Validate a change

```bash
pnpm --dir docs build
```

The build refreshes generated pages, validates sidebar targets and links, and creates the static site in `docs/.vitepress/dist`.

See [Docs Site — Developer Guide](dev/docs-site.md) for architecture and publishing details.
