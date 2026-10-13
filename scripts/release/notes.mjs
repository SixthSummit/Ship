import assert from "node:assert/strict";

export function changelogEntry(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  assert(start !== -1, `Missing changelog entry for ${version}`);
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
}
