// Builds the site's reference pages from the product docs in this same repository, so
// they stay single-source: edit docs/dev/*.md (or CONTRIBUTING.md / SECURITY.md) and rebuild.
//
//   ../docs/dev/**/*.md  -> reference/**/*.md   (generated, git-ignored)
//   ../CONTRIBUTING.md   -> project/contributing.md (generated, git-ignored)
//   ../SECURITY.md       -> project/security.md (generated, git-ignored)
//   ../CHANGELOG.md      -> project/changelog.md (generated, git-ignored)
//
// Run automatically by `pnpm dev` and `pnpm build`. Do not edit the generated files; every
// page has an "Edit this page" link that goes to the real source.
//
// Links are rewritten so the site has no dead links: links to other synced pages become site
// links, links to source files become GitHub links, and links to files that do not exist
// anywhere are turned into plain text and reported.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const REPO = "atlantiqshq/vexlyx";
// ROOT is this docs/ folder (the VitePress root); the product repo root is one level up.
const ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(ROOT, "..");
const OUT_REFERENCE = join(ROOT, "reference");
const OUT_PROJECT = join(ROOT, "project");

const toPosix = (p) => p.split(sep).join("/");

// Code-fence languages the highlighter does not know, mapped to ones it does.
const FENCE_LANGUAGES = {
  dns: "text",
  sieve: "text",
  caddy: "text",
  env: "dotenv",
};

function walkMarkdown(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(full));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

/** Repo-relative POSIX path -> site path of the page it becomes, or null if it is not synced. */
function sitePathFor(repoRel) {
  if (repoRel.startsWith("docs/dev/") && repoRel.endsWith(".md"))
    return "/reference/" + repoRel.slice("docs/dev/".length, -3);
  if (repoRel === "CONTRIBUTING.md") return "/project/contributing";
  if (repoRel === "SECURITY.md") return "/project/security";
  if (repoRel === "CHANGELOG.md") return "/project/changelog";
  return null;
}

function rewriteLinks(markdown, srcRel, sourceRoot, warnings) {
  const srcDir = posix.dirname(srcRel);
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line.replace(
          /^(\s*(?:```|~~~))([a-zA-Z0-9_+-]+)/,
          (whole, fence, lang) =>
            FENCE_LANGUAGES[lang] ? `${fence}${FENCE_LANGUAGES[lang]}` : whole,
        );
      }
      if (inFence) return line;
      // The site renders raw HTML as text, so a table-cell line break becomes a space.
      line = line.replace(/<br\s*\/?>/gi, " ");
      // [text](url): text may contain one level of brackets, e.g. `[id]` in a Next.js route; url has no spaces and may contain one level of parentheses, as in Next.js
      // route groups like (panel). Images are left alone.
      return line.replace(
        /(?<!!)\[((?:[^[\]]|\[[^[\]]*\])*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
        (whole, text, url) => {
          if (/^(https?:|mailto:|#|\/)/i.test(url)) return whole;
          const [rawPath, hash = ""] = url.split(/#(.*)/s);
          const withHash = (base) => (hash ? `${base}#${hash}` : base);
          // Some docs link to absolute local paths like file:///d:/learing/Vexlyx/apps/api/x.ts.
          // Treat everything after the repo folder name as a repo-relative path.
          const decodedPath = (() => {
            try {
              return decodeURIComponent(rawPath); // %5Bid%5D -> [id] (Next.js dynamic routes)
            } catch {
              return rawPath;
            }
          })();
          const pathPart = decodedPath.replace(
            /^file:\/\/\/[a-z]:\/(?:[^/]+\/)*?Vexlyx\//i,
            "",
          );

          const candidates = [
            posix.normalize(posix.join(srcDir, pathPart)),
            // Several docs link as if from the repo root (../packages/...) while sitting in docs/dev/.
            pathPart.replace(/^(\.\.?\/)+/, ""),
          ];
          const found = candidates.find(
            (c) => c && !c.startsWith("..") && existsSync(join(sourceRoot, c)),
          );
          if (!found) {
            warnings.push(
              `${srcRel}: [${text}](${url}) not found, left as plain text`,
            );
            return text;
          }
          const site = sitePathFor(found);
          if (site) return `[${text}](${withHash(site)})`;
          const kind = statSync(join(sourceRoot, found)).isDirectory()
            ? "tree"
            : "blob";
          return `[${text}](${withHash(`https://github.com/${REPO}/${kind}/main/${encodeURI(found)}`)})`;
        },
      );
    })
    .join("\n");
}

// Most product docs open with an internal-tracking blockquote right after the H1 — feature code,
// completion status, a date that goes stale, sometimes package/Prisma-model/dependency lists.
// It's read here as source-of-truth metadata by the product team, but it reads as ticket noise on
// a public docs site (and every page already restates what it does in the prose that follows), so
// strip it from the rendered page. Leaves everything alone if a page doesn't have one.
function stripLeadingMetaBlockquote(markdown) {
  const lines = markdown.split("\n");
  const h1 = lines.findIndex((l) => l.startsWith("# "));
  if (h1 === -1) return markdown;

  let i = h1 + 1;
  while (lines[i] === "") i++;
  // Only a "**Label:** value" blockquote is metadata — a few pages open with a genuine prose
  // blockquote instead (e.g. a "see CLAUDE.md for more" pointer), which must stay untouched.
  if (lines[i] === undefined || !/^>\s*\*\*[^*]+:\*\*/.test(lines[i]))
    return markdown;

  while (lines[i] !== undefined && lines[i].startsWith(">")) i++;
  while (lines[i] === "") i++;
  if (lines[i] === "---") {
    i++;
    while (lines[i] === "") i++;
  }

  return [...lines.slice(0, h1 + 1), "", ...lines.slice(i)].join("\n");
}

function clean(dir, keep) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      clean(full, keep);
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    } else if (entry.name.endsWith(".md") && !keep.includes(entry.name))
      rmSync(full);
  }
}

const source = { root: REPO_ROOT };
const warnings = [];
try {
  clean(OUT_REFERENCE, ["index.md"]);
  clean(OUT_PROJECT, ["index.md"]);

  const jobs = walkMarkdown(join(source.root, "docs", "dev")).map((abs) => {
    const srcRel = toPosix(relative(source.root, abs));
    return {
      abs,
      srcRel,
      out: join(OUT_REFERENCE, ...srcRel.slice("docs/dev/".length).split("/")),
    };
  });
  jobs.push({
    abs: join(source.root, "CONTRIBUTING.md"),
    srcRel: "CONTRIBUTING.md",
    out: join(OUT_PROJECT, "contributing.md"),
  });
  jobs.push({
    abs: join(source.root, "SECURITY.md"),
    srcRel: "SECURITY.md",
    out: join(OUT_PROJECT, "security.md"),
  });
  jobs.push({
    abs: join(source.root, "CHANGELOG.md"),
    srcRel: "CHANGELOG.md",
    out: join(OUT_PROJECT, "changelog.md"),
  });

  for (const job of jobs) {
    if (!existsSync(job.abs)) {
      warnings.push(`${job.srcRel}: missing in source, skipped`);
      continue;
    }
    const body = stripLeadingMetaBlockquote(
      rewriteLinks(
        readFileSync(job.abs, "utf8").replace(/\r\n/g, "\n"),
        job.srcRel,
        source.root,
        warnings,
      ),
    );
    mkdirSync(dirname(job.out), { recursive: true });
    // Page metadata (front matter), not an HTML comment: the site renders raw HTML as text.
    writeFileSync(
      job.out,
      `---\ngenerated: true\nsource: ${job.srcRel}\n---\n\n${body}`,
    );
  }

  console.log(`Generated ${jobs.length} reference pages from docs/dev`);
  if (warnings.length)
    console.log(
      `\n${warnings.length} link warning(s):\n  ${warnings.join("\n  ")}`,
    );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
