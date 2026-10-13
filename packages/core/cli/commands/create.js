import chalk from "chalk";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Project-name validator (F17). Mirrors npm's package-name rules
 * (the loose subset that travels safely in directory paths). Reject
 * names that:
 *   - contain path separators (`/`, `\`)
 *   - contain `..` (parent-dir traversal, even if `path.resolve` would
 *     later catch it)
 *   - contain null bytes (filesystem string-termination footgun)
 *   - start with `.` (hidden / dotfile collision)
 *   - start with a digit (npm forbids; npm-compatible names start with
 *     a letter)
 *   - contain anything outside `[a-zA-Z0-9_-]`
 *
 * Rejecting up front avoids filesystem clobbering of user-owned paths
 * via `ship-api create ../../../etc/foo` (the `path.resolve` call
 * downstream resolves out of `cwd` without these checks).
 */
const PROJECT_NAME_RE = /^[a-z][a-z0-9_-]*$/i;
const FORBIDDEN_CHARS = ["/", "\\", "\0", ".."];

export function validateProjectName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return "must be a non-empty string";
  }
  for (const forbidden of FORBIDDEN_CHARS) {
    if (name.includes(forbidden)) {
      return `must not contain ${JSON.stringify(forbidden)}`;
    }
  }
  if (!PROJECT_NAME_RE.test(name)) {
    return "must match /^[a-z][a-z0-9_-]*$/i (npm-package-name rules: start with a letter, then letters / digits / `-` / `_`)";
  }
  return null;
}

export async function createProject(projectName, _options) {
  const isCurrentDirectory = _options.currentDir;

  // F17: name validation. Skipped when `--current-dir` because that
  // path uses cwd, not the name, and is purely a display string then.
  if (!isCurrentDirectory) {
    const reason = validateProjectName(projectName);
    if (reason) {
      console.error(chalk.red(`✗ Invalid project name "${projectName}": ${reason}`));
      process.exit(1);
    }
  }

  const projectPath = isCurrentDirectory ? process.cwd() : path.resolve(process.cwd(), projectName);
  const displayName = isCurrentDirectory ? "current directory" : projectName;

  console.log(chalk.blue(`🚀 Creating ShipAPI project: ${projectName}`));
  if (isCurrentDirectory) {
    console.log(chalk.blue(`📁 Installing in current directory`));
  }

  // Check if directory already exists (only for new directories)
  if (!isCurrentDirectory) {
    try {
      await fs.access(projectPath);
      throw new Error(`Directory ${projectName} already exists`);
    } catch (_error) {
      if (_error.code !== "ENOENT") {
        throw _error;
      }
    }

    // Create project directory
    await fs.mkdir(projectPath, { recursive: true });
  }

  // Copy template files
  await copyTemplate(projectPath, _options.template);

  // Process template placeholders
  await processTemplateFiles(projectPath, projectName);

  // Install dependencies
  if (!_options.skipInstall) {
    console.log(chalk.yellow("📦 Installing dependencies..."));
    process.chdir(projectPath);
    execSync("npm install", { stdio: "inherit" });
  }

  // Initialize git
  if (!_options.skipGit) {
    console.log(chalk.yellow("🔧 Initializing git repository..."));
    try {
      execSync("git init", { stdio: "inherit" });
      execSync("git add .", { stdio: "inherit" });
      execSync('git commit -m "Initial commit: ShipAPI project setup"', { stdio: "inherit" });
    } catch (_error) {
      console.log(chalk.yellow("⚠️  Git initialization failed, continuing..."));
    }
  }

  console.log(chalk.green(`✅ Project "${projectName}" created successfully in ${displayName}!`));
  console.log(chalk.cyan(`\nNext steps:`));
  if (!isCurrentDirectory) {
    console.log(chalk.cyan(`  cd ${projectName}`));
  }
  console.log(chalk.cyan(`  npx ship-api add accounts   # Add authentication module`));
  console.log(chalk.cyan(`  npm run local`));
  console.log(chalk.cyan(`\nDocumentation: https://github.com/SixthSummit/Ship`));
}

async function copyTemplate(projectPath, template) {
  const templatePath = path.join(__dirname, "..", "..", "templates", template);

  try {
    await fs.access(templatePath);
  } catch (_error) {
    throw new Error(`Template '${template}' not found`);
  }

  await copyDirectory(templatePath, projectPath);
}

async function copyDirectory(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    // npm strips .gitignore (and other dot-leading ignore files) during
    // package publish — templates work around it by shipping
    // `_gitignore` and renaming on scaffold. Same trick as
    // `create-next-app` and friends. Generalized to `_<name>` → `.<name>`
    // so future ignore-style files (`.npmignore`, `.dockerignore`, etc.)
    // can use the same convention.
    const destName = entry.name.startsWith("_") ? "." + entry.name.slice(1) : entry.name;
    const destPath = path.join(dest, destName);

    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function processTemplateFiles(projectPath, projectName) {
  // Determine ship-api version to use
  const shipApiVersion = await getShipApiVersion();
  const observabilityVersion = await getBundledDependencyVersion(
    "@sixthsummit/ship-observability-otel",
    "observability-otel",
  );
  console.log(chalk.blue(`📦 Using @sixthsummit/ship-api version: ${shipApiVersion}`));

  // Process package.json - parse as JSON and update fields
  const packageJsonPath = path.join(projectPath, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  packageJson.name = projectName;

  // Insert @sixthsummit/ship-api at the beginning of dependencies, with
  // the version resolved by getShipApiVersion(). Templates SHOULD NOT
  // declare @sixthsummit/ship-api themselves — but defensively strip it
  // from existingDeps before the spread so the explicit version wins
  // (otherwise the template's stale literal overrides via property-key
  // collision).
  const {
    "@sixthsummit/ship-api": _existingShipApi,
    "@sixthsummit/ship-observability-otel": _existingObservability,
    ...existingDeps
  } = packageJson.dependencies ?? {};
  packageJson.dependencies = {
    "@sixthsummit/ship-api": shipApiVersion,
    "@sixthsummit/ship-observability-otel": observabilityVersion,
    ...existingDeps,
  };

  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

  // Process .env.example - update PROJECT_ROOT
  const envExamplePath = path.join(projectPath, ".env.example");
  try {
    let envExample = await fs.readFile(envExamplePath, "utf8");
    envExample = envExample.replace(/PROJECT_ROOT=.*/, `PROJECT_ROOT=${projectPath}`);
    envExample = envExample.replace(
      /DATABASE_URL=postgresql:\/\/username:password@localhost:5432\/.*/,
      `DATABASE_URL=postgresql://username:password@localhost:5432/${projectName}`,
    );
    await fs.writeFile(envExamplePath, envExample);
  } catch (_error) {
    // .env.example might not exist, that's okay
  }
}

async function getShipApiVersion() {
  // Read ship-api's package.json to get current version
  const shipApiPackageJsonPath = path.join(__dirname, "..", "..", "package.json");
  const shipApiPackageJson = JSON.parse(await fs.readFile(shipApiPackageJsonPath, "utf8"));
  const currentVersion = shipApiPackageJson.version;
  const isPrerelease = currentVersion.includes("-"); // e.g., 3.0.0-beta.1

  if (isPrerelease) {
    // For prereleases (beta, rc), use caret range to allow updates to newer betas and stable
    // ^3.0.0-beta.1 will match 3.0.0-beta.2, 3.0.0, 3.0.1, etc.
    return `^${currentVersion}`;
  }

  // For stable releases, try to get the latest stable version from npm
  try {
    const latestVersion = execSync("npm view @sixthsummit/ship-api version", {
      encoding: "utf8",
    }).trim();
    return `^${latestVersion}`;
  } catch (_error) {
    // If npm view fails, use current version
    return `^${currentVersion}`;
  }
}

/**
 * Resolve a package split out of the monolith to the version declared by the
 * installed CLI. Published package manifests contain a normal semver range;
 * the workspace fallback keeps local scaffold tests deterministic.
 */
export async function getBundledDependencyVersion(packageName, workspaceDirectory) {
  const shipApiPackageJsonPath = path.join(__dirname, "..", "..", "package.json");
  const shipApiPackageJson = JSON.parse(await fs.readFile(shipApiPackageJsonPath, "utf8"));
  const declared = shipApiPackageJson.dependencies?.[packageName];

  if (typeof declared !== "string") {
    throw new Error(`${packageName} is not declared by @sixthsummit/ship-api`);
  }
  if (!declared.startsWith("workspace:")) return declared;

  const workspacePackageJsonPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    workspaceDirectory,
    "package.json",
  );
  const workspacePackageJson = JSON.parse(await fs.readFile(workspacePackageJsonPath, "utf8"));
  return `^${workspacePackageJson.version}`;
}
