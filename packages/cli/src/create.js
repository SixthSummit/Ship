import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PROJECT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEXT_FILE_PATTERN = /(?:^|\/)(?:[^/]+\.(?:json|md|ts)|_gitignore|_gitmessage)$/u;

export class ScaffoldError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ScaffoldError";
  }
}

/**
 * @typedef {{
 *   schemaVersion: 1,
 *   packageManager: string,
 *   packages: Record<string, string>,
 *   dependencies: Record<string, string>,
 *   devDependencies: Record<string, string>
 * }} ScaffoldReleaseManifest
 */

/**
 * @param {string} manifestPath
 * @returns {Promise<ScaffoldReleaseManifest>}
 */
export async function loadScaffoldReleaseManifest(manifestPath) {
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new ScaffoldError(
      `could not read the scaffold release manifest at ${manifestPath}: ${errorMessage(error)}`,
    );
  }
  if (
    value?.schemaVersion !== 1 ||
    typeof value.packageManager !== "string" ||
    !isStringRecord(value.packages) ||
    !isStringRecord(value.dependencies) ||
    !isStringRecord(value.devDependencies)
  ) {
    throw new ScaffoldError(`invalid scaffold release manifest at ${manifestPath}`);
  }
  return value;
}

/**
 * Create the smallest operation-native Ship application.
 *
 * @param {{
 *   projectName: string,
 *   cwd?: string,
 *   currentDirectory?: boolean,
 *   skipInstall?: boolean,
 *   templateDirectory: string,
 *   releaseManifest: ScaffoldReleaseManifest,
 *   install?: (targetDirectory: string) => void,
 *   spawn?: (command: string, args: string[], options: object) => {
 *     error?: Error,
 *     status: number | null
 *   }
 * }} options
 */
export async function createOperationProject(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const currentDirectory = options.currentDirectory === true;
  if (!currentDirectory && options.projectName === ".") {
    throw new ScaffoldError("project name `.` requires --current-dir");
  }
  const packageName =
    currentDirectory && options.projectName === "." ? basename(cwd) : options.projectName;
  validateProjectName(packageName);

  const targetDirectory = currentDirectory ? cwd : resolve(cwd, options.projectName);
  const createdTarget = !currentDirectory;
  await assertWritableTarget(targetDirectory, currentDirectory);

  try {
    if (createdTarget) await mkdir(targetDirectory);
    await cp(options.templateDirectory, targetDirectory, { recursive: true, errorOnExist: true });
    await renameTemplateDotfiles(targetDirectory);
    await renderTemplate(targetDirectory, {
      PROJECT_NAME: displayName(packageName),
      PACKAGE_NAME: packageName,
      PACKAGE_MANAGER: options.releaseManifest.packageManager,
    });
    await writeGeneratedPackageJson(targetDirectory, packageName, options.releaseManifest);

    if (!options.skipInstall) {
      if (options.install) options.install(targetDirectory);
      else installDependencies(targetDirectory, options.spawn ?? spawnSync);
    }
  } catch (error) {
    if (createdTarget) await rm(targetDirectory, { force: true, recursive: true });
    if (error instanceof ScaffoldError) throw error;
    throw new ScaffoldError(`could not create ${packageName}: ${errorMessage(error)}`);
  }

  return {
    packageName,
    targetDirectory,
    installed: !options.skipInstall,
  };
}

/** @param {string} projectName */
function validateProjectName(projectName) {
  if (!PROJECT_NAME_PATTERN.test(projectName)) {
    throw new ScaffoldError(
      "project name must be lower-case kebab-case using letters, numbers, and single hyphens",
    );
  }
}

/** @param {string} targetDirectory @param {boolean} currentDirectory */
async function assertWritableTarget(targetDirectory, currentDirectory) {
  if (currentDirectory) {
    const entries = await readdir(targetDirectory);
    if (entries.length > 0) {
      throw new ScaffoldError("--current-dir requires an empty directory");
    }
    return;
  }

  try {
    await stat(targetDirectory);
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") return;
    throw error;
  }
  throw new ScaffoldError(`target already exists: ${targetDirectory}`);
}

/** @param {string} targetDirectory */
async function renameTemplateDotfiles(targetDirectory) {
  await rename(join(targetDirectory, "_gitignore"), join(targetDirectory, ".gitignore"));
  await rename(join(targetDirectory, "_gitmessage"), join(targetDirectory, ".gitmessage"));
}

/** @param {string} targetDirectory @param {Record<string, string>} replacements */
async function renderTemplate(targetDirectory, replacements) {
  for (const path of await listFiles(targetDirectory)) {
    const relativePath = path.slice(targetDirectory.length).replaceAll("\\", "/");
    if (!TEXT_FILE_PATTERN.test(relativePath)) continue;
    let content = await readFile(path, "utf8");
    for (const [key, value] of Object.entries(replacements)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
    await writeFile(path, content);
  }
}

/** @param {string} directory @returns {Promise<string[]>} */
async function listFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await listFiles(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

/**
 * @param {string} targetDirectory
 * @param {string} packageName
 * @param {ScaffoldReleaseManifest} manifest
 */
async function writeGeneratedPackageJson(targetDirectory, packageName, manifest) {
  const sourcePath = join(targetDirectory, "package.template.json");
  const packageJson = JSON.parse(await readFile(sourcePath, "utf8"));
  packageJson.name = packageName;
  packageJson.packageManager = manifest.packageManager;
  packageJson.dependencies = {
    ...manifest.packages,
    ...manifest.dependencies,
  };
  packageJson.devDependencies = manifest.devDependencies;
  await writeFile(
    join(targetDirectory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await rm(sourcePath);
}

/**
 * @param {string} targetDirectory
 * @param {(command: string, args: string[], options: object) => {
 *   error?: Error,
 *   status: number | null
 * }} spawn
 */
function installDependencies(targetDirectory, spawn) {
  const result = spawn("pnpm", ["install"], {
    cwd: targetDirectory,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new ScaffoldError(`pnpm install exited with ${result.status ?? "no status"}`);
  }
}

/** @param {string} value */
function displayName(value) {
  return value
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** @param {unknown} value */
function isStringRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
