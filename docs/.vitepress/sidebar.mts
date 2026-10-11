import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const docsRoot = resolve(import.meta.dirname, "..");

interface Group {
  text: string;
  /** Page paths without extension, relative to docs/, in display order. */
  pages: string[];
}

const groups: Group[] = [
  {
    text: "Start here",
    pages: [
      "guide/getting-started",
      "guide/installation",
      "guide/docker",
      "guide/local-development",
    ],
  },
  {
    text: "Use Vexlyx",
    pages: [
      "guide/deploying",
      "guide/domains-and-ssl",
      "guide/email",
      "guide/operations",
      "guide/troubleshooting",
      "guide/features",
    ],
  },
  {
    text: "Foundation",
    pages: [
      "reference/monorepo",
      "reference/api-setup",
      "reference/dashboard-setup",
      "reference/shared-package",
      "reference/database",
      "reference/infrastructure",
      "reference/design-system",
    ],
  },
  {
    text: "Access and security",
    pages: [
      "reference/authentication",
      "reference/roles-permissions",
      "reference/fine-grained-permissions",
      "reference/reseller-overselling",
      "reference/audit-log",
    ],
  },
  {
    text: "Projects and deployment",
    pages: [
      "reference/projects-api",
      "reference/projects-ui",
      "reference/project-detail-page",
      "reference/git-integration",
      "reference/github-integration",
      "reference/github-webhooks",
      "reference/build-system",
      "reference/deployment-engine",
      "reference/realtime-logs",
      "reference/environment-variables",
    ],
  },
  {
    text: "Runtimes",
    pages: [
      "reference/runtimes/nextjs",
      "reference/runtimes/python",
      "reference/runtimes/react-vite",
      "reference/runtimes/php-wordpress",
      "reference/runtimes/custom-dockerfile",
      "reference/fast-static-wordpress-serving",
      "reference/no-build-php-hosting",
    ],
  },
  {
    text: "Domains, DNS and SSL",
    pages: [
      "reference/domains",
      "reference/subdomains",
      "reference/dns-management",
      "reference/dns-onboarding",
      "reference/domain-routing",
      "reference/ssl-management",
    ],
  },
  {
    text: "Email",
    pages: [
      "reference/email/postfix",
      "reference/email/dovecot",
      "reference/email/mailbox-management",
      "reference/email/webmail",
      "reference/email/authentication",
      "reference/email/aliases",
      "reference/email/vacation-responder",
      "reference/email/mail-operations",
      "reference/system-transactional-email",
    ],
  },
  {
    text: "Databases and files",
    pages: ["reference/database-provisioning", "reference/file-manager-sftp"],
  },
  {
    text: "Operations",
    pages: [
      "reference/installer",
      "reference/monitoring",
      "reference/backup-system",
      "reference/firewall",
      "reference/service-status",
      "reference/docker-cleanup",
      "reference/ci-cd",
      "reference/settings-page",
      "reference/dashboard-home",
    ],
  },
  { text: "API", pages: ["api/index"] },
  {
    text: "Project",
    pages: [
      "project/index",
      "project/contributing",
      "project/security",
      "project/changelog",
    ],
  },
];

/** Sidebar label from the page's first heading, without feature codes like "F3.1 — " or " (F3.1)". */
function titleOf(page: string): string {
  const file = join(docsRoot, `${page}.md`);
  const heading = readFileSync(file, "utf8")
    .split("\n")
    .find((line) => line.startsWith("# "));
  return (heading ?? `# ${page.split("/").pop()}`)
    .slice(2)
    .replace(/`/g, "")
    .replace(/^F\d+\.\d+\s*[—–-]\s*/, "")
    .replace(/\s*\(F\d+\.\d+\)\s*$/, "")
    .replace(/\s*[—–-]\s*Developer Guide\s*$/i, "")
    .trim();
}

function allPages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return allPages(full);
    return entry.name.endsWith(".md")
      ? [relative(docsRoot, full).split(sep).join("/").replace(/\.md$/, "")]
      : [];
  });
}

export function buildSidebar() {
  const listed = new Set(groups.flatMap((g) => g.pages));
  const missing = groups
    .flatMap((g) => g.pages)
    .filter((p) => !existsSync(join(docsRoot, `${p}.md`)));
  if (missing.length)
    throw new Error(
      `Sidebar lists pages that do not exist: ${missing.join(", ")}`,
    );

  // Pages the sync brought in that no group mentions still appear, so nothing is hidden.
  const extra = allPages(join(docsRoot, "reference")).filter(
    (p) => p !== "reference/index" && !listed.has(p),
  );
  const all = extra.length
    ? [...groups, { text: "More", pages: extra.sort() }]
    : groups;

  return [
    {
      text: "Overview",
      items: [{ text: "Reference overview", link: "/reference/" }],
    },
    ...all.map((g) => ({
      text: g.text,
      collapsed: !["Start here", "Use Vexlyx"].includes(g.text),
      items: g.pages.map((p) => ({ text: titleOf(p), link: `/${p}` })),
    })),
  ];
}
