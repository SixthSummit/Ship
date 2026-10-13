import chalk from 'chalk';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

export async function updateProject(options) {
  console.log(chalk.blue(`🔄 Updating ShipAngular framework...`));

  const projectPath = process.cwd();

  // Check if we're in a ShipAngular project
  const packageJsonPath = path.join(projectPath, 'package.json');
  let packageJson;

  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    if (!packageJson.dependencies?.['@sixthsummit/ship-angular']) {
      throw new Error('Not a ShipAngular project. Run this command from your project root.');
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('No package.json found. Run this command from your project root.', {
        cause: error,
      });
    }
    throw error;
  }

  const currentVersion = packageJson.dependencies['@sixthsummit/ship-angular'];
  console.log(chalk.gray(`  Current version: ${currentVersion}`));

  // Get latest version from the configured package registry.
  let latestVersion;
  try {
    latestVersion = execSync('pnpm view @sixthsummit/ship-angular version', {
      encoding: 'utf8',
    }).trim();
    console.log(chalk.gray(`  Latest version: ${latestVersion}`));
  } catch (_error) {
    console.log(chalk.yellow('⚠️  Could not fetch the latest package version'));
    console.log(chalk.yellow('  Check network access and the configured npm registry'));
    return;
  }

  // Check if update is needed
  const cleanCurrent = currentVersion.replace(/[\^~]/, '');
  if (cleanCurrent === latestVersion) {
    console.log(chalk.green('\n✅ Already on the latest version!'));
    return;
  }

  // Update package.json
  packageJson.dependencies['@sixthsummit/ship-angular'] = `^${latestVersion}`;
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

  // Install the updated dependency with the repository package manager.
  console.log(chalk.yellow('\n📦 Installing updated package...'));
  try {
    execSync('pnpm install', { stdio: 'inherit' });
  } catch (_error) {
    console.log(chalk.red('❌ Failed to install updated package'));
    return;
  }

  console.log(chalk.green(`\n✅ Updated to @sixthsummit/ship-angular@${latestVersion}!`));

  // Show changelog hint
  console.log(chalk.cyan(`\nChangelog: https://github.com/sixthsummit/ship-angular/releases`));
}
