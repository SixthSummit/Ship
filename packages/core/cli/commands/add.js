import chalk from "chalk";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Install npm dependencies
 * Supports two formats:
 * - Array of package names: ["lodash", "uuid"] (installs latest version)
 * - Object with versions: {"lodash": "^4.17.21", "uuid": "^9.0.0"}
 *
 * @param {string[] | Record<string, string>} npmDependencies - Dependencies to install
 * @param {string} projectPath - Path to the project
 */
async function installNpmDependencies(npmDependencies, projectPath) {
  if (!npmDependencies) {
    return;
  }

  let packages;

  if (Array.isArray(npmDependencies)) {
    // Array format: ["lodash", "uuid"]
    if (npmDependencies.length === 0) {
      return;
    }
    packages = npmDependencies.join(" ");
  } else if (typeof npmDependencies === "object") {
    // Object format: {"lodash": "^4.17.21"}
    if (Object.keys(npmDependencies).length === 0) {
      return;
    }
    packages = Object.entries(npmDependencies)
      .map(([name, version]) => `${name}@${version}`)
      .join(" ");
  } else {
    return;
  }

  console.log(chalk.blue(`📦 Installing npm dependencies...`));

  try {
    execSync(`npm install ${packages}`, {
      cwd: projectPath,
      stdio: "inherit",
    });
    console.log(chalk.green(`✅ Dependencies installed successfully`));
  } catch (error) {
    console.error(chalk.red(`❌ Failed to install dependencies: ${error.message}`));
    console.log(chalk.yellow(`\nYou can install them manually:`));
    console.log(chalk.yellow(`  npm install ${packages}`));
  }
}

export async function addModule(moduleName, options, _installedDeps = new Set()) {
  // Track installed dependencies to prevent circular installs
  if (_installedDeps.has(moduleName)) {
    return;
  }

  console.log(chalk.blue(`📦 Adding module: ${moduleName}`));

  const projectPath = process.cwd();

  // Check if we're in a ShipAPI project
  const packageJsonPath = path.join(projectPath, "package.json");
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    if (!packageJson.dependencies?.["@sixthsummit/ship-api"]) {
      throw new Error("Not a ShipAPI project. Run this command from your project root.");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("No package.json found. Run this command from your project root.");
    }
    throw error;
  }

  // Find the module in the modules directory
  // In development, modules are at ../../modules relative to cli/commands
  // When published, modules are copied to lib/modules
  let modulesDir = path.join(__dirname, "..", "..", "..", "..", "modules");

  // Check if we're running from the published package (lib/modules exists)
  const libModulesDir = path.join(__dirname, "..", "..", "lib", "modules");
  try {
    await fs.access(libModulesDir);
    modulesDir = libModulesDir;
  } catch {
    // Use the repo modules directory
  }

  const moduleSourcePath = path.join(modulesDir, moduleName);
  const moduleJsonPath = path.join(moduleSourcePath, "module.json");

  // Check if module exists
  try {
    await fs.access(moduleSourcePath);
  } catch {
    console.error(chalk.red(`❌ Module '${moduleName}' not found.`));
    console.log(chalk.yellow(`\nAvailable modules:`));
    await listAvailableModules(modulesDir);
    process.exit(1);
  }

  // Read module metadata
  let moduleInfo = { name: moduleName, description: "", postInstall: [], dependencies: [] };
  try {
    moduleInfo = JSON.parse(await fs.readFile(moduleJsonPath, "utf8"));
  } catch {
    // No module.json, use defaults
  }

  // Install ShipAPI dependencies first (other modules or libraries)
  if (moduleInfo.dependencies && moduleInfo.dependencies.length > 0) {
    console.log(chalk.blue(`\n📋 Installing dependencies for ${moduleName}...`));
    for (const dep of moduleInfo.dependencies) {
      if (_installedDeps.has(dep)) {
        console.log(chalk.gray(`  ⏭️  ${dep} already installed`));
        continue;
      }

      // Try to install as module first, then as library
      const isModule = await isAvailableModule(dep, modulesDir);
      const librariesDir = await getLibrariesDir();
      const isLibrary = await isAvailableLibrary(dep, librariesDir);

      if (isModule) {
        await addModule(dep, { ...options, force: false }, _installedDeps);
      } else if (isLibrary) {
        await addLibrary(dep, { ...options, force: false }, _installedDeps);
      } else {
        console.log(chalk.yellow(`  ⚠️  Dependency '${dep}' not found as module or library`));
      }
    }
    console.log(chalk.blue(`\n📦 Continuing with ${moduleName}...`));
  }

  // Mark this module as being installed
  _installedDeps.add(moduleName);

  // Check if module already exists in project
  const destPath = path.join(projectPath, "src", "modules", moduleName);
  try {
    await fs.access(destPath);
    if (!options.force) {
      console.log(chalk.gray(`  ⏭️  Module '${moduleName}' already exists, skipping`));
      return;
    }
    console.log(chalk.yellow(`⚠️  Overwriting existing module: ${moduleName}`));
    await fs.rm(destPath, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Copy module files (excluding module.json)
  await copyModuleFiles(moduleSourcePath, destPath);

  // Install npm dependencies if specified
  if (moduleInfo.npmDependencies) {
    await installNpmDependencies(moduleInfo.npmDependencies, projectPath);
  }

  console.log(chalk.green(`✅ Module '${moduleName}' added successfully!`));

  // Print post-install instructions
  if (moduleInfo.postInstall && moduleInfo.postInstall.length > 0) {
    console.log(chalk.cyan(`\nNext steps:`));
    moduleInfo.postInstall.forEach((step) => {
      console.log(chalk.cyan(`  • ${step}`));
    });
  }

  if (moduleInfo.requiredEnvVars && moduleInfo.requiredEnvVars.length > 0) {
    console.log(chalk.yellow(`\nRequired environment variables:`));
    moduleInfo.requiredEnvVars.forEach((envVar) => {
      console.log(chalk.yellow(`  • ${envVar}`));
    });
  }

  if (moduleInfo.optionalEnvVars && moduleInfo.optionalEnvVars.length > 0) {
    console.log(chalk.gray(`\nOptional environment variables:`));
    moduleInfo.optionalEnvVars.forEach((envVar) => {
      console.log(chalk.gray(`  • ${envVar}`));
    });
  }
}

/**
 * Check if a module is available
 */
async function isAvailableModule(name, modulesDir) {
  try {
    await fs.access(path.join(modulesDir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a library is available
 */
async function isAvailableLibrary(name, librariesDir) {
  try {
    await fs.access(path.join(librariesDir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the libraries directory path
 */
async function getLibrariesDir() {
  const librariesDir = path.join(__dirname, "..", "..", "..", "..", "libraries");
  const libLibrariesDir = path.join(__dirname, "..", "..", "lib", "libraries");

  try {
    await fs.access(libLibrariesDir);
    return libLibrariesDir;
  } catch {
    return librariesDir;
  }
}

async function copyModuleFiles(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    // Skip module.json - it's only for CLI metadata
    if (entry.name === "module.json") continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyModuleFiles(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export async function listModules() {
  console.log(chalk.blue(`📦 Available modules:\n`));

  // Find modules directory
  let modulesDir = path.join(__dirname, "..", "..", "..", "..", "modules");
  const libModulesDir = path.join(__dirname, "..", "..", "lib", "modules");

  try {
    await fs.access(libModulesDir);
    modulesDir = libModulesDir;
  } catch {
    // Use the repo modules directory
  }

  await listAvailableModules(modulesDir);
}

async function listAvailableModules(modulesDir) {
  try {
    const entries = await fs.readdir(modulesDir, { withFileTypes: true });
    const modules = entries.filter((e) => e.isDirectory());

    for (const mod of modules) {
      const moduleJsonPath = path.join(modulesDir, mod.name, "module.json");
      let description = "";

      try {
        const moduleInfo = JSON.parse(await fs.readFile(moduleJsonPath, "utf8"));
        description = moduleInfo.description || "";
      } catch {
        // No module.json
      }

      console.log(chalk.white(`  ${mod.name.padEnd(20)} ${chalk.gray(description)}`));
    }
  } catch (_error) {
    console.log(chalk.yellow(`  No modules found.`));
  }
}

// ============================================================================
// Library Functions
// ============================================================================

export async function addLibrary(libraryName, options, _installedDeps = new Set()) {
  // Track installed dependencies to prevent circular installs
  if (_installedDeps.has(libraryName)) {
    return;
  }

  console.log(chalk.blue(`📚 Adding library: ${libraryName}`));

  const projectPath = process.cwd();

  // Check if we're in a ShipAPI project
  const packageJsonPath = path.join(projectPath, "package.json");
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    if (!packageJson.dependencies?.["@sixthsummit/ship-api"]) {
      throw new Error("Not a ShipAPI project. Run this command from your project root.");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("No package.json found. Run this command from your project root.");
    }
    throw error;
  }

  // Find the library in the libraries directory
  // In development, libraries are at ../../libraries relative to cli/commands
  // When published, libraries are copied to lib/libraries
  const librariesDir = await getLibrariesDir();

  const librarySourcePath = path.join(librariesDir, libraryName);
  const libraryJsonPath = path.join(librarySourcePath, "library.json");

  // Check if library exists
  try {
    await fs.access(librarySourcePath);
  } catch {
    console.error(chalk.red(`❌ Library '${libraryName}' not found.`));
    console.log(chalk.yellow(`\nAvailable libraries:`));
    await listAvailableLibraries(librariesDir);
    process.exit(1);
  }

  // Read library metadata
  let libraryInfo = { name: libraryName, description: "", postInstall: [], dependencies: [] };
  try {
    libraryInfo = JSON.parse(await fs.readFile(libraryJsonPath, "utf8"));
  } catch {
    // No library.json, use defaults
  }

  // Install ShipAPI dependencies first (other modules or libraries)
  if (libraryInfo.dependencies && libraryInfo.dependencies.length > 0) {
    console.log(chalk.blue(`\n📋 Installing dependencies for ${libraryName}...`));

    // Get modules directory for checking
    let modulesDir = path.join(__dirname, "..", "..", "..", "..", "modules");
    const libModulesDir = path.join(__dirname, "..", "..", "lib", "modules");
    try {
      await fs.access(libModulesDir);
      modulesDir = libModulesDir;
    } catch {
      // Use the repo modules directory
    }

    for (const dep of libraryInfo.dependencies) {
      if (_installedDeps.has(dep)) {
        console.log(chalk.gray(`  ⏭️  ${dep} already installed`));
        continue;
      }

      // Try to install as module first, then as library
      const isModule = await isAvailableModule(dep, modulesDir);
      const isLibrary = await isAvailableLibrary(dep, librariesDir);

      if (isModule) {
        await addModule(dep, { ...options, force: false }, _installedDeps);
      } else if (isLibrary) {
        await addLibrary(dep, { ...options, force: false }, _installedDeps);
      } else {
        console.log(chalk.yellow(`  ⚠️  Dependency '${dep}' not found as module or library`));
      }
    }
    console.log(chalk.blue(`\n📚 Continuing with ${libraryName}...`));
  }

  // Mark this library as being installed
  _installedDeps.add(libraryName);

  // Check if library already exists in project (destination: src/lib/)
  const destPath = path.join(projectPath, "src", "lib", libraryName);
  try {
    await fs.access(destPath);
    if (!options.force) {
      console.log(chalk.gray(`  ⏭️  Library '${libraryName}' already exists, skipping`));
      return;
    }
    console.log(chalk.yellow(`⚠️  Overwriting existing library: ${libraryName}`));
    await fs.rm(destPath, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Ensure src/lib directory exists
  await fs.mkdir(path.join(projectPath, "src", "lib"), { recursive: true });

  // Copy library files (excluding library.json)
  await copyLibraryFiles(librarySourcePath, destPath);

  // AI-A3: stamp the vendored library version into the consumer so the
  // independently-versioned `library.json#version` is recorded + diffable on
  // `ship-api update`. Mirrors the g-scaffold provenance breadcrumb; the
  // `library.json` itself stays CLI-only metadata (skipped on copy above).
  await writeLibraryStamp(destPath, libraryName, libraryInfo, options);

  // NOTE: Libraries don't update config/modules.ts

  // Install npm dependencies if specified
  if (libraryInfo.npmDependencies) {
    await installNpmDependencies(libraryInfo.npmDependencies, projectPath);
  }

  console.log(chalk.green(`✅ Library '${libraryName}' added successfully!`));

  // Print usage example
  console.log(chalk.cyan(`\nUsage:`));
  console.log(chalk.gray(`  import { ... } from "./lib/${libraryName}/index.js";`));

  // Print post-install instructions
  if (libraryInfo.postInstall && libraryInfo.postInstall.length > 0) {
    console.log(chalk.cyan(`\nNext steps:`));
    libraryInfo.postInstall.forEach((step) => {
      console.log(chalk.cyan(`  • ${step}`));
    });
  }

  if (libraryInfo.requiredEnvVars && libraryInfo.requiredEnvVars.length > 0) {
    console.log(chalk.yellow(`\nRequired environment variables:`));
    libraryInfo.requiredEnvVars.forEach((envVar) => {
      console.log(chalk.yellow(`  • ${envVar}`));
    });
  }

  if (libraryInfo.optionalEnvVars && libraryInfo.optionalEnvVars.length > 0) {
    console.log(chalk.gray(`\nOptional environment variables:`));
    libraryInfo.optionalEnvVars.forEach((envVar) => {
      console.log(chalk.gray(`  • ${envVar}`));
    });
  }
}

async function copyLibraryFiles(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    // Skip library.json - it's only for CLI metadata
    if (entry.name === "library.json") continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyLibraryFiles(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * AI-A3 — write the vendored-library provenance stamp into the consumer's
 * copied library dir. Records the library's independent `version` (from its
 * `library.json`, which itself isn't copied) so staleness is detectable and
 * `ship-api update` has an anchor to diff against. `options.now` /
 * `options.frameworkVersion` are injectable for deterministic tests.
 */
export async function writeLibraryStamp(destPath, libraryName, libraryInfo, options = {}) {
  const stamp = {
    name: libraryInfo.name ?? libraryName,
    version: libraryInfo.version ?? "unknown",
    source: "ship-api add -l",
    at: options.now ?? new Date().toISOString(),
    frameworkVersion: options.frameworkVersion ?? (await resolveFrameworkVersion()),
  };
  await fs.writeFile(path.join(destPath, ".ship-lib.json"), JSON.stringify(stamp, null, 2) + "\n");
}

/** The running `@sixthsummit/ship-api` version (packages/core/package.json). */
async function resolveFrameworkVersion() {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(__dirname, "..", "..", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function listLibraries() {
  console.log(chalk.blue(`📚 Available libraries:\n`));

  // Find libraries directory
  let librariesDir = path.join(__dirname, "..", "..", "..", "..", "libraries");
  const libLibrariesDir = path.join(__dirname, "..", "..", "lib", "libraries");

  try {
    await fs.access(libLibrariesDir);
    librariesDir = libLibrariesDir;
  } catch {
    // Use the repo libraries directory
  }

  await listAvailableLibraries(librariesDir);
}

async function listAvailableLibraries(librariesDir) {
  try {
    const entries = await fs.readdir(librariesDir, { withFileTypes: true });
    const libraries = entries.filter((e) => e.isDirectory());

    if (libraries.length === 0) {
      console.log(chalk.yellow(`  No libraries available yet.`));
      return;
    }

    for (const lib of libraries) {
      const libraryJsonPath = path.join(librariesDir, lib.name, "library.json");
      let description = "";

      try {
        const libraryInfo = JSON.parse(await fs.readFile(libraryJsonPath, "utf8"));
        description = libraryInfo.description || "";
      } catch {
        // No library.json
      }

      console.log(chalk.white(`  ${lib.name.padEnd(20)} ${chalk.gray(description)}`));
    }
  } catch (_error) {
    console.log(chalk.yellow(`  No libraries found.`));
  }
}
