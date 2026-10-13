import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const coreRoot = path.join(__dirname, "..", "packages", "core");
const skippedDirectories = new Set(["__tests__", "examples", "node_modules"]);
const skippedSourcePattern = /\.(?:test|integration\.test|parity\.test|typecheck|example)\.[^.]+$/u;

async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (
      (entry.isDirectory() && skippedDirectories.has(entry.name)) ||
      (!entry.isDirectory() && skippedSourcePattern.test(entry.name))
    ) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function createPackageJson() {
  // Create a package.json for the lib directory to help with module resolution
  const libPackageJson = {
    type: "module",
    sideEffects: false,
  };

  const libPackageJsonPath = path.join(coreRoot, "lib", "package.json");
  await fs.writeFile(libPackageJsonPath, JSON.stringify(libPackageJson, null, 2));
  console.log("✓ Created lib/package.json for module resolution");
}

async function copyModulesToLib() {
  // Copy modules directory to lib for CLI access
  const modulesPath = path.join(__dirname, "..", "modules");
  const libModulesPath = path.join(coreRoot, "lib", "modules");

  try {
    await fs.access(modulesPath);
    await copyDirectory(modulesPath, libModulesPath);
    console.log("✓ Copied modules to lib/modules");
  } catch (_error) {
    console.log("⚠️  No modules directory found, skipping modules copy");
  }
}

async function copyLibrariesToLib() {
  // Copy libraries directory to lib for CLI access
  const librariesPath = path.join(__dirname, "..", "libraries");
  const libLibrariesPath = path.join(coreRoot, "lib", "libraries");

  try {
    await fs.access(librariesPath);
    await copyDirectory(librariesPath, libLibrariesPath);
    console.log("✓ Copied libraries to lib/libraries");
  } catch (_error) {
    console.log("⚠️  No libraries directory found, skipping libraries copy");
  }
}

async function buildCore() {
  console.log("Post-build tasks for @sixthsummit/ship-api...");

  try {
    // Create package.json for module resolution
    await createPackageJson();

    // Copy modules to lib for distribution
    await copyModulesToLib();

    // Copy libraries to lib for distribution
    await copyLibrariesToLib();

    console.log("✓ Core package build complete!");
  } catch (error) {
    console.error("Build failed:", error.message);
    process.exit(1);
  }
}

buildCore().catch(console.error);
