import { defineConfig } from "vitepress";

import { buildSidebar } from "./sidebar.mts";

const siteUrl = "https://docs.vexlyx.atlantiqs.org";
const repo = "https://github.com/atlantiqshq/vexlyx";

export default defineConfig({
  title: "Vexlyx Docs",
  description:
    "Documentation for Vexlyx, the open-source hybrid hosting control panel by Atlantiqs.",
  lang: "en-US",
  cleanUrls: true,
  // docs/dev holds the sources the reference pages are generated from (see scripts/sync-docs.mjs);
  // docs/superpowers holds internal plans and specs. Neither is part of the site.
  srcExclude: ["**/README.md", "dev/**", "superpowers/**"],
  sitemap: { hostname: siteUrl },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#4f46e5" }],
    ["meta", { property: "og:site_name", content: "Vexlyx Docs" }],
    ["meta", { property: "og:type", content: "website" }],
  ],
  markdown: {
    // The reference pages are plain documentation, not Vue. Render raw HTML as text and stop Vue
    // from interpreting {{ }} (the docs use it for template placeholders such as {{php_root}}).
    html: false,
    // High-contrast syntax themes keep code readable (WCAG AA) in both color modes.
    theme: {
      light: "github-light-high-contrast",
      dark: "github-dark-high-contrast",
    },
    config(md) {
      md.core.ruler.push("vexlyx-v-pre", (state) => {
        for (const token of state.tokens) {
          if (token.level === 0 && token.nesting === 1)
            token.attrSet("v-pre", "");
        }
      });
    },
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "Vexlyx Docs",
    nav: [
      { text: "Get started", link: "/guide/getting-started" },
      { text: "Guides", link: "/guide/deploying", activeMatch: "/guide/" },
      { text: "API", link: "/api/", activeMatch: "/api/" },
      { text: "Developer", link: "/reference/", activeMatch: "/reference/" },
      {
        text: "Project",
        link: "/project/",
        activeMatch: "/project/",
      },
      { text: "Website", link: "https://vexlyx.atlantiqs.org" },
    ],
    sidebar: buildSidebar(),
    socialLinks: [{ icon: "github", link: repo }],
    search: { provider: "local" },
    outline: { level: [2, 3] },
    lastUpdated: {
      text: "Updated",
      formatOptions: {
        dateStyle: "medium",
      },
    },
    editLink: {
      // Must be self-contained: VitePress rebuilds this function on the client without its scope.
      // Reference and project pages are generated from their sources, so edit those instead.
      pattern: ({ filePath }) => {
        const repo = "https://github.com/atlantiqshq/vexlyx";
        if (filePath.startsWith("reference/"))
          return `${repo}/edit/main/docs/dev/${filePath.slice("reference/".length)}`;
        if (filePath === "project/contributing.md")
          return `${repo}/edit/main/CONTRIBUTING.md`;
        if (filePath === "project/security.md")
          return `${repo}/edit/main/SECURITY.md`;
        if (filePath === "project/changelog.md")
          return `${repo}/edit/main/CHANGELOG.md`;
        return `${repo}/edit/main/docs/${filePath}`;
      },
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT license.",
      copyright:
        'Vexlyx is an open-source project by <a href="https://atlantiqs.org">Atlantiqs</a>.',
    },
  },
});
