#!/usr/bin/env node
/**
 * copy-docs.mjs
 *
 * Mirrors a curated v4-only slice of the repo's markdown into
 * apps/docs/src/content/docs/ for the Starlight site. Runs as
 * predev / prebuild from apps/docs/.
 *
 * Source-of-truth invariant: the site is a *projection*. Every
 * file in the allow-list below stays canonical at its source path
 * (so AGENTS.md @-imports, the Claude plugin's SKILL.md sync, and
 * agents reading the rules directly all keep working).
 *
 * v1 scope: v4 docs only. The legacy v3 doc tree (docs/getting-started,
 * docs/development, docs/architecture, etc.) is intentionally NOT
 * projected — it'll be cleaned up at the v4 cut-over (B4) and
 * shouldn't accumulate archive-page debt on the site in the meantime.
 *
 * Transforms applied per file:
 *  1. Inject Starlight frontmatter (title from first H1, description
 *     from first paragraph below the H1, stripped of inline markdown).
 *  2. Strip the source H1 (Starlight renders `title` as the page heading).
 *  3. Rewrite cross-doc links to either site slugs (when the link target
 *     is in the allow-list) or GitHub blob URLs on the `main` branch
 *     (when the target lives outside the projected slice — e.g.
 *     .cursor/rules/, packages/, modules/).
 *
 * Adapted from ShipAngular's scripts/copy-docs.mjs — same shape,
 * v4-only allow-list, ship-api repo URLs.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const targetRoot = resolve(repoRoot, "apps/docs/src/content/docs");

const REPO_BLOB_URL = "https://github.com/SixthSummit/Ship/blob/dev";

/**
 * v4-only allow-list. Each entry is `{ src, target, title? }`:
 *   - `src`     — repo-relative POSIX path to the source markdown.
 *   - `target`  — POSIX path relative to apps/docs/src/content/docs/.
 *                 Must end in `.md`. Subdirs are created as needed.
 *   - `title?`  — overrides the first-H1 title for the projection.
 *                 Use when the source H1 is a Mustache placeholder
 *                 (templates), or when the source title is too
 *                 long / context-loaded for a Starlight sidebar entry.
 *
 * Adding a file: append to this list (no need to touch the walker).
 * Removing a file: delete the entry; `clean()` removes the projected
 * copy on next run.
 */
const ALLOW_LIST = [
  // Reference (v4 launch + status + migration)
  { src: "docs/V4_LAUNCH.md", target: "v4-launch.md" },
  { src: "docs/V4_STATUS.md", target: "v4-status.md" },
  { src: "docs/MIGRATION_V3_TO_V4.md", target: "migration-v3-to-v4.md" },
  { src: "docs/PUBLIC_API_SURFACE.md", target: "public-api-surface.md" },
  { src: "docs/VERSIONING.md", target: "versioning.md" },

  // Getting Started
  { src: "AGENTS.md", target: "getting-started/agents.md" },
  {
    src: "packages/cli/templates/operation/README.md",
    target: "getting-started/operation-template.md",
    title: "Operation template",
  },
  { src: "docs/v4/quick-start.md", target: "getting-started/quick-start.md" },
  { src: "docs/v4/project-structure.md", target: "getting-started/project-structure.md" },

  // Core Concepts
  { src: "docs/v4/concepts/lifecycle.md", target: "concepts/lifecycle.md" },
  { src: "docs/v4/concepts/routes-and-validation.md", target: "concepts/routes-and-validation.md" },
  { src: "docs/v4/concepts/services.md", target: "concepts/services.md" },
  { src: "docs/v4/concepts/authentication.md", target: "concepts/authentication.md" },
  { src: "docs/v4/concepts/permissions.md", target: "concepts/permissions.md" },
  { src: "docs/v4/concepts/errors.md", target: "concepts/errors.md" },
  { src: "docs/v4/concepts/database.md", target: "concepts/database.md" },
  { src: "docs/v4/concepts/tenancy.md", target: "concepts/tenancy.md" },

  // Cross-Framework
  { src: "docs/v4/cross-framework/typed-client.md", target: "cross-framework/typed-client.md" },
  { src: "docs/v4/cross-framework/shipangular.md", target: "cross-framework/shipangular.md" },
  {
    src: "docs/v4/cross-framework/react-native-expo.md",
    target: "cross-framework/react-native-expo.md",
  },

  // Tooling
  { src: "docs/v4/tooling/cli.md", target: "tooling/cli.md" },
  { src: "docs/v4/tooling/generators.md", target: "tooling/generators.md" },
  { src: "docs/v4/tooling/claude-plugin.md", target: "tooling/claude-plugin.md" },
  { src: "docs/v4/tooling/mcp-server.md", target: "tooling/mcp-server.md" },
  { src: "docs/v4/tooling/sherpa-qa-briefs.md", target: "tooling/sherpa-qa-briefs.md" },
  { src: "docs/v4/tooling/parity-harness.md", target: "tooling/parity-harness.md" },

  // Production Features (Phase B)
  { src: "docs/v4/features/jobs.md", target: "features/jobs.md" },
  { src: "docs/v4/features/observability.md", target: "features/observability.md" },
  { src: "docs/v4/features/cache.md", target: "features/cache.md" },
  { src: "docs/v4/features/storage.md", target: "features/storage.md" },
  { src: "docs/v4/features/rate-limit.md", target: "features/rate-limit.md" },
  { src: "docs/v4/features/idempotency.md", target: "features/idempotency.md" },
  { src: "docs/v4/features/webhooks.md", target: "features/webhooks.md" },
  { src: "docs/v4/features/uploads.md", target: "features/uploads.md" },
  { src: "docs/v4/features/health-checks.md", target: "features/health-checks.md" },
  { src: "docs/v4/features/sessions.md", target: "features/sessions.md" },
  { src: "docs/v4/features/streaming.md", target: "features/streaming.md" },
  { src: "docs/v4/features/websockets.md", target: "features/websockets.md" },
  { src: "docs/v4/features/llm-helpers.md", target: "features/llm-helpers.md" },
  { src: "docs/v4/features/mail.md", target: "features/mail.md" },
];

/**
 * Reverse-lookup: source repo-relative POSIX path → target site slug.
 * Used by `rewriteLinks` to turn `[label](docs/V4_STATUS.md)` into
 * `[label](/v4-status/)`. Only allow-listed files become site links;
 * anything else becomes a GitHub blob URL.
 */
const SLUG_MAP = new Map(ALLOW_LIST.map(({ src, target }) => [src, targetToSlug(target)]));

function targetToSlug(targetRelMd) {
  // "v4-launch.md" → "/v4-launch/"
  // "getting-started/agents.md" → "/getting-started/agents/"
  return "/" + targetRelMd.replace(/\.md$/i, "") + "/";
}

function parseFrontmatter(markdown) {
  const lines = markdown.split("\n");
  let title = null;
  const descriptionLines = [];
  let i = 0;
  // Find first H1.
  for (; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      title = m[1].trim();
      i++;
      break;
    }
  }
  // Skip blanks after H1.
  while (i < lines.length && lines[i].trim() === "") i++;
  // Capture the next non-empty block as the description (until blank line).
  while (i < lines.length && lines[i].trim() !== "") {
    descriptionLines.push(lines[i].trim());
    i++;
  }
  // Drop blockquote markers BEFORE joining — V4_LAUNCH.md and V4_STATUS.md
  // open with multi-line blockquotes (audience tag + status). Each line
  // starts with `> `; we strip per-line then join.
  let description = descriptionLines
    .map((line) => line.replace(/^>\s*/, ""))
    .join(" ")
    .trim();
  // Strip basic inline markdown for the description meta tag.
  description = description
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ");
  if (description.length > 200) description = description.slice(0, 197) + "…";
  return { title, description };
}

function stripFirstH1(markdown) {
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+.+/.test(lines[i])) {
      // Drop the H1 and any single blank line directly after it.
      lines.splice(i, 1);
      if (i < lines.length && lines[i].trim() === "") lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  return markdown;
}

/**
 * Rewrite `[label](relative/or/absolute-from-repo-root/PATH.md)` and
 * `[label](./BAR.md)` into either:
 *   - A site slug (when the target is in the allow-list), or
 *   - A GitHub blob URL on `main` (when the target lives outside the
 *     projected slice — agents and human readers can still follow the
 *     link, just to the canonical source on GitHub).
 *
 * Absolute URLs (https://, mailto:), in-page anchors (#…), and root-
 * absolute paths (/foo) are left untouched.
 */
function rewriteLinks(markdown, srcRepoRel) {
  const srcAbs = resolve(repoRoot, srcRepoRel);
  return markdown.replace(/\]\(([^)]+)\)/g, (full, target) => {
    if (
      /^https?:\/\//i.test(target) ||
      target.startsWith("mailto:") ||
      target.startsWith("#") ||
      target.startsWith("/")
    ) {
      return full;
    }
    // Split off any #anchor and ?query.
    const hashIdx = target.search(/[#?]/);
    const path = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const tail = hashIdx === -1 ? "" : target.slice(hashIdx);

    // Resolve relative to the source file, then make it repo-relative.
    const resolvedAbs = resolve(dirname(srcAbs), path);
    const repoRel = relative(repoRoot, resolvedAbs).split(/\\|\//).join(posix.sep);

    if (repoRel.startsWith("..")) {
      // Link escapes the repo entirely (rare; usually a typo). Leave alone.
      return full;
    }

    // Allow-listed → site slug.
    const slug = SLUG_MAP.get(repoRel);
    if (slug) return `](${slug}${tail})`;

    // Outside the projection → GitHub blob URL on main. Preserves the
    // ability to follow the link, just goes to the canonical source.
    return `](${REPO_BLOB_URL}/${repoRel}${tail})`;
  });
}

function escapeYamlString(value) {
  return value.replace(/"/g, '\\"');
}

async function processEntry({ src, target, title: titleOverride }) {
  const srcAbs = resolve(repoRoot, src);
  if (!(await exists(srcAbs))) {
    throw new Error(`copy-docs: source not found at ${src} (declared in ALLOW_LIST)`);
  }
  const targetAbs = resolve(targetRoot, target);
  const raw = await readFile(srcAbs, "utf8");
  const { title: extractedTitle, description } = parseFrontmatter(raw);
  const title = titleOverride ?? extractedTitle ?? src;
  const stripped = stripFirstH1(raw);
  const linked = rewriteLinks(stripped, src);
  const fm = ["---", `title: "${escapeYamlString(title)}"`];
  if (description) fm.push(`description: "${escapeYamlString(description)}"`);
  fm.push("---", "");
  const out = fm.join("\n") + linked.trimStart();
  await mkdir(dirname(targetAbs), { recursive: true });
  await writeFile(targetAbs, out, "utf8");
  return target;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove every file/dir the allow-list owns, so a removed entry doesn't
 * leave a stale projected copy behind. Idempotent.
 */
async function clean() {
  // Every directory and root-level `.md` below targetRoot is generated. The
  // hand-authored splash page is `index.mdx` and is deliberately preserved.
  // Removing the whole generated projection also cleans targets deleted from
  // ALLOW_LIST instead of leaving stale public routes behind.
  for (const entry of await readdir(targetRoot, { withFileTypes: true })) {
    const path = resolve(targetRoot, entry.name);
    if (entry.isDirectory()) await rm(path, { recursive: true, force: true });
    else if (entry.isFile() && entry.name.endsWith(".md")) await rm(path, { force: true });
  }
}

async function main() {
  await mkdir(targetRoot, { recursive: true });
  await clean();
  const written = [];
  for (const entry of ALLOW_LIST) {
    written.push(await processEntry(entry));
  }
  written.sort();
  console.log(`copy-docs: synced ${written.length} files into ${relative(repoRoot, targetRoot)}/`);
  for (const rel of written) console.log(`  - ${rel}`);
}

main().catch((err) => {
  console.error("copy-docs failed:", err);
  process.exit(1);
});
