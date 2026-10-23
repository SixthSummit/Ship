import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Every physical copy of `packageName` under an npm-style `node_modules`
 * tree, including copies nested under other packages.
 */
export async function findInstalledCopies(nodeModules, packageName) {
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const copies = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const packageDirectories = entry.name.startsWith("@")
      ? (await readdir(resolve(nodeModules, entry.name), { withFileTypes: true }))
          .filter((scoped) => scoped.isDirectory())
          .map((scoped) => [
            `${entry.name}/${scoped.name}`,
            resolve(nodeModules, entry.name, scoped.name),
          ])
      : [[entry.name, resolve(nodeModules, entry.name)]];
    for (const [name, directory] of packageDirectories) {
      if (name === packageName) copies.push(directory);
      copies.push(...(await findInstalledCopies(resolve(directory, "node_modules"), packageName)));
    }
  }
  return copies;
}

/**
 * Every version of `packageName` in a pnpm virtual store
 * (`node_modules/.pnpm/<name>@<version>...`). pnpm installs one directory per
 * resolved version, so two directories mean the project resolved two copies.
 */
export async function findPnpmStoreCopies(projectDirectory, packageName) {
  const store = resolve(projectDirectory, "node_modules", ".pnpm");
  let entries;
  try {
    entries = await readdir(store, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const prefix = `${packageName.replace("/", "+")}@`;
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => resolve(store, entry.name));
}

/** Throws unless `project` resolved exactly one copy of every named package. */
export async function assertSingleCopies(projectDirectory, packageNames, layout) {
  for (const name of packageNames) {
    const copies =
      layout === "pnpm"
        ? await findPnpmStoreCopies(projectDirectory, name)
        : await findInstalledCopies(resolve(projectDirectory, "node_modules"), name);
    if (copies.length !== 1) {
      throw new Error(
        `${layout} installed ${copies.length} copies of ${name} in ${projectDirectory}; expected exactly one:\n  ${copies.join("\n  ")}`,
      );
    }
  }
}

/**
 * The consumer-side half of the single-copy rule: Ship packages are pinned
 * exactly and `hono` is the caret range `@sixthsummit/ship-hono` declares as
 * its peer, so a caret bump of the Ship packages cannot leave an exact `hono`
 * pin behind (the two-Hono-copies failure of the project template).
 */
export function assertConsumerPinShape(manifest, honoPeerRange, label) {
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith("@sixthsummit/") && /^[\^~<>=]/u.test(range)) {
        throw new Error(`${label} must pin ${name} exactly, found ${JSON.stringify(range)}`);
      }
    }
  }
  const hono = manifest.dependencies?.hono;
  if (hono !== undefined && hono !== honoPeerRange) {
    throw new Error(
      `${label} must declare hono as ${JSON.stringify(honoPeerRange)} (ship-hono's peer range), found ${JSON.stringify(hono)}`,
    );
  }
}
