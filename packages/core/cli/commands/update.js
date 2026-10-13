import chalk from "chalk";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";

export async function updateProject(_options) {
  console.log(chalk.blue("🔄 Updating ShipAPI project..."));

  // Check if we're in a ShipAPI project
  const packageJsonPath = path.join(process.cwd(), "package.json");
  let packageJson;

  try {
    const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
    packageJson = JSON.parse(packageJsonContent);
  } catch (_error) {
    throw new Error("Not in a valid Node.js project directory");
  }

  if (!packageJson.dependencies || !packageJson.dependencies["@sixthsummit/ship-api"]) {
    throw new Error("This is not a ShipAPI project (@sixthsummit/ship-api dependency not found)");
  }

  // Update ship-api package
  console.log(chalk.yellow("📦 Updating @sixthsummit/ship-api package..."));
  try {
    execSync("npm update @sixthsummit/ship-api", { stdio: "inherit" });
  } catch (_error) {
    console.log(chalk.red("Failed to update @sixthsummit/ship-api package"));
    throw _error;
  }

  console.log(chalk.green("✅ Project updated successfully!"));
  console.log(chalk.cyan("\nNext steps:"));
  console.log(chalk.cyan("  npm run build"));
  console.log(chalk.cyan("  npm run test"));
}
