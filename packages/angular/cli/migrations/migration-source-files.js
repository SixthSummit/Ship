import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set([
  '.angular',
  '.git',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);
const TEST_FILE = /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/;

export async function listMigrationSourceFiles(directory, options = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...(await listMigrationSourceFiles(target, options)));
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (!(options.includeTests ?? false) && TEST_FILE.test(toPosix(target))) continue;
    files.push(target);
  }
  return files;
}

export function toPosix(value) {
  return value.split(path.sep).join('/');
}
