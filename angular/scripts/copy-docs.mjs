#!/usr/bin/env node
/**
 * copy-docs.mjs
 *
 * Mirrors the canonical /docs tree into ../apps/angular-docs/src/content/docs/ for the
 * Starlight site. Runs as predev / prebuild from ../apps/angular-docs.
 *
 * Transforms applied per file:
 *  1. Lowercase the file path (FOO_BAR.md -> foo-bar.md, kept as kebab-case).
 *  2. Inject Starlight frontmatter (title from first H1, description from
 *     first paragraph below the H1, stripped of inline markdown).
 *  3. Strip the source H1 (Starlight renders `title` as the page heading).
 *  4. Rewrite relative cross-doc links: `../foo/BAR.md` -> `/foo/bar/`.
 *  5. Skip the source root README (we ship a hand-written index.mdx).
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sourceRoot = resolve(repoRoot, 'docs');
const targetRoot = resolve(repoRoot, '../apps/angular-docs/src/content/docs');

// Subdirs the build script owns (it cleans + repopulates these on every run).
// Hand-written content like index.mdx lives at the root and is left alone.
const MANAGED_SUBDIRS = [
  'getting-started',
  'architecture',
  'development',
  'api',
  'guides',
  'evidence',
];
// Top-level files copied flat into the docs root.
const MANAGED_TOP_LEVEL_FILES = new Set([
  '404.md',
  'CI_SETUP.md',
  'INTERIM_BACKEND.md',
  'ROADMAP.md',
  'STABLE_PROMOTION_READINESS.md',
  'STABLE_RELEASE_HANDOFF.md',
]);

function toSlug(name) {
  return name.replace(/\.md$/i, '').replace(/_/g, '-').toLowerCase();
}

function toTargetRelPath(srcRel) {
  const parts = srcRel.split(posix.sep);
  const file = parts.pop();
  const dir = parts.map(p => p.toLowerCase()).join(posix.sep);
  const slug = toSlug(file);
  return dir ? posix.join(dir, `${slug}.md`) : `${slug}.md`;
}

function parseFrontmatter(markdown) {
  const lines = markdown.split('\n');
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
  while (i < lines.length && lines[i].trim() === '') i++;
  // Capture the next non-empty block as the description (until blank line).
  while (i < lines.length && lines[i].trim() !== '') {
    descriptionLines.push(lines[i].trim());
    i++;
  }
  let description = descriptionLines.join(' ').trim();
  // Strip basic inline markdown for the description meta tag.
  description = description
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ');
  if (description.length > 200) description = description.slice(0, 197) + '…';
  return { title, description };
}

function stripFirstH1(markdown) {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+.+/.test(lines[i])) {
      // Drop the H1 and any single blank line directly after it.
      lines.splice(i, 1);
      if (i < lines.length && lines[i].trim() === '') lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  return markdown;
}

/**
 * Rewrite `[label](../foo/BAR.md)` and `[label](./BAR.md)` to Starlight slugs.
 * Absolute URLs and #anchors are left untouched.
 */
function rewriteLinks(markdown, srcAbsPath) {
  return markdown.replace(/\]\(([^)]+)\)/g, (full, target) => {
    if (
      /^https?:\/\//i.test(target) ||
      target.startsWith('mailto:') ||
      target.startsWith('#') ||
      target.startsWith('/')
    ) {
      return full;
    }
    // Split off any #anchor and ?query.
    const hashIdx = target.search(/[#?]/);
    const path = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const tail = hashIdx === -1 ? '' : target.slice(hashIdx);
    if (!/\.mdx?$/i.test(path)) return full; // Don't rewrite non-md links.
    // Resolve relative to the source file, then make it relative to docs root.
    const resolvedAbs = resolve(dirname(srcAbsPath), path);
    const rel = relative(sourceRoot, resolvedAbs).split(/\\|\//).join(posix.sep);
    if (rel.startsWith('..')) {
      // Link points outside /docs — rewrite to GitHub blob URL on the dev branch
      // so it still resolves on the deployed site.
      const repoRel = relative(resolve(repoRoot, '..'), resolvedAbs).split(/\\|\//).join(posix.sep);
      return `](https://github.com/SixthSummit/Ship/blob/dev/${repoRel}${tail})`;
    }
    if (/^README\.md$/i.test(rel)) return `](/${tail.replace(/^#?/, tail ? '#' : '')})`;
    // Drop extension, kebab-case, lowercase dirs.
    const parts = rel.split(posix.sep);
    const file = parts.pop().replace(/\.mdx?$/i, '');
    const dir = parts.map(p => p.toLowerCase()).join(posix.sep);
    const slug = file.replace(/_/g, '-').toLowerCase();
    const url = dir ? `/${dir}/${slug}/${tail}` : `/${slug}/${tail}`;
    return `](${url})`;
  });
}

function escapeYamlString(value) {
  return value.replace(/"/g, '\\"');
}

async function processFile(srcAbsPath) {
  const srcRel = relative(sourceRoot, srcAbsPath).split(/\\|\//).join(posix.sep);
  if (srcRel === 'README.md') return null; // hand-written index.mdx wins
  const targetRel = toTargetRelPath(srcRel);
  const targetAbs = resolve(targetRoot, targetRel);
  const raw = await readFile(srcAbsPath, 'utf8');
  const { title, description } = parseFrontmatter(raw);
  const stripped = stripFirstH1(raw);
  const linked = rewriteLinks(stripped, srcAbsPath);
  const fm = ['---', `title: "${escapeYamlString(title || srcRel)}"`];
  if (description) fm.push(`description: "${escapeYamlString(description)}"`);
  fm.push('---', '');
  const out = fm.join('\n') + linked.trimStart();
  await mkdir(dirname(targetAbs), { recursive: true });
  await writeFile(targetAbs, out, 'utf8');
  return targetRel;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs)));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

async function clean() {
  for (const sub of MANAGED_SUBDIRS) {
    await rm(resolve(targetRoot, sub), { recursive: true, force: true });
  }
  for (const file of MANAGED_TOP_LEVEL_FILES) {
    await rm(resolve(targetRoot, toSlug(file) + '.md'), { force: true });
  }
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(sourceRoot))) {
    throw new Error(`Source docs directory not found: ${sourceRoot}`);
  }
  await mkdir(targetRoot, { recursive: true });
  await clean();
  const sources = await walk(sourceRoot);
  const written = [];
  for (const src of sources) {
    const result = await processFile(src);
    if (result) written.push(result);
  }
  // Sort for stable output ordering in CI logs.
  written.sort();
  console.log(`copy-docs: synced ${written.length} files into ${relative(repoRoot, targetRoot)}/`);
  for (const rel of written) console.log(`  - ${rel}`);
}

main().catch(err => {
  console.error('copy-docs failed:', err);
  process.exit(1);
});
