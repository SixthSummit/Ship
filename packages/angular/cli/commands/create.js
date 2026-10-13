import chalk from 'chalk';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createProject(projectName, options) {
  const isCurrentDirectory = options.currentDir;
  const projectPath = isCurrentDirectory ? process.cwd() : path.resolve(process.cwd(), projectName);
  const displayName = isCurrentDirectory ? 'current directory' : projectName;

  console.log(chalk.blue(`\n🚀 Creating ShipAngular project: ${chalk.bold(projectName)}\n`));
  if (isCurrentDirectory) {
    console.log(chalk.gray(`   Installing in current directory\n`));
  }

  // Check if directory already exists (only for new directories)
  if (!isCurrentDirectory) {
    try {
      await fs.access(projectPath);
      throw new Error(`Directory ${projectName} already exists`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    // Create project directory
    await fs.mkdir(projectPath, { recursive: true });
  } else {
    await assertCurrentDirectoryIsSafe(projectPath);
  }

  // Copy template files
  const templatePath = await copyTemplate(projectPath, options.template);

  // Read template.json for placeholders
  const templateConfig = await readTemplateConfig(templatePath);

  // Get placeholder values (from options or defaults)
  const placeholders = await resolvePlaceholders(projectName, templateConfig, options);

  // Process template placeholders in all files
  await processTemplateFiles(projectPath, placeholders);

  // Install dependencies
  if (!options.skipInstall) {
    console.log(chalk.yellow('📦 Installing dependencies...\n'));
    process.chdir(projectPath);
    try {
      execSync('pnpm install', { stdio: 'inherit' });
    } catch (error) {
      console.log(chalk.yellow('\n⚠️  pnpm install failed. You can run it manually later.\n'));
    }
  }

  // Initialize git
  if (!options.skipGit) {
    console.log(chalk.yellow('\n🔧 Initializing git repository...'));
    try {
      execSync('git init', { stdio: 'pipe', cwd: projectPath });
      execSync('git add .', { stdio: 'pipe', cwd: projectPath });
      execSync('git commit -m "chore: initialize ShipAngular project"', {
        stdio: 'pipe',
        cwd: projectPath,
      });
      console.log(chalk.gray('   Git repository initialized\n'));
    } catch (_error) {
      console.log(chalk.gray('   Git initialization skipped\n'));
    }
  }

  // Print success message
  printSuccessMessage(projectName, displayName, isCurrentDirectory, templateConfig);
}

async function copyTemplate(projectPath, template) {
  const templatePath = path.join(__dirname, '..', '..', 'templates', template);

  try {
    await fs.access(templatePath);
  } catch (error) {
    throw new Error(`Template '${template}' not found`, { cause: error });
  }

  console.log(chalk.gray(`   Copying template files...`));
  await copyDirectory(templatePath, projectPath);
  console.log(chalk.gray(`   Template files copied\n`));

  return templatePath;
}

async function copyDirectory(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    // Skip template.json - it's only for CLI metadata
    if (entry.name === 'template.json') continue;

    const srcPath = path.join(src, entry.name);

    // Rename leading-dot files that npm strips at publish time. The
    // template stores them without the leading dot; restore on copy.
    let destName = entry.name;
    if (entry.name === 'gitignore') {
      destName = '.gitignore';
    } else if (entry.name === 'npmrc') {
      destName = '.npmrc';
    } else if (entry.name === 'biome.template.json') {
      // Keeping a second biome.json inside this repository would create a
      // nested-root configuration error. Restore the canonical name only in
      // the generated standalone application.
      destName = 'biome.json';
    }

    const destPath = path.join(dest, destName);

    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function readTemplateConfig(templatePath) {
  const configPath = path.join(templatePath, 'template.json');
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (_error) {
    return { placeholders: {} };
  }
}

async function resolvePlaceholders(projectName, templateConfig, options) {
  const placeholders = {};
  const config = templateConfig.placeholders || {};

  // Always set PROJECT_NAME from the command argument
  placeholders.PROJECT_NAME = projectName;

  // Derive APP_NAME from project name if not specified
  placeholders.APP_NAME = config.APP_NAME?.default || toTitleCase(projectName);

  // Set defaults for all placeholders
  for (const [key, value] of Object.entries(config)) {
    if (!placeholders[key]) {
      placeholders[key] = value.default || '';
    }
  }

  // Set the ship-angular version
  placeholders.SHIP_ANGULAR_VERSION = await getShipAngularVersion();

  return placeholders;
}

async function processTemplateFiles(projectPath, placeholders) {
  console.log(chalk.gray(`   Processing template placeholders...`));

  // Process package.json specially - parse as JSON
  await processPackageJson(projectPath, placeholders);

  // Process angular.json specially - parse as JSON
  await processAngularJson(projectPath, placeholders);

  // List of files with placeholders to process. Add new files here when
  // adding template-side artifacts that carry {{PROJECT_NAME}} or
  // similar — the placeholder substitution is opt-in per file.
  const filesToProcess = [
    'src/index.html',
    'src/environments/environment.ts',
    'src/environments/environment.development.ts',
    'src/environments/environment.production.ts',
    'README.md',
    // Phase 2 — SSR + Cloud Run artifacts.
    'Dockerfile',
    'cloudbuild.yaml',
    'app.yaml',
    // Phase 4 — template-side .claude plugin (project-personalized).
    '.claude/CLAUDE.md',
  ];

  for (const file of filesToProcess) {
    await replaceInFile(path.join(projectPath, file), placeholders);
  }

  console.log(chalk.gray(`   Placeholders processed\n`));
}

async function processPackageJson(projectPath, placeholders) {
  const packageJsonPath = path.join(projectPath, 'package.json');

  try {
    const content = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(content);

    // Set name from placeholder
    packageJson.name = placeholders.PROJECT_NAME;

    // Update description if we have one
    if (placeholders.PROJECT_DESCRIPTION) {
      packageJson.description = placeholders.PROJECT_DESCRIPTION;
    }

    // Update @sixthsummit/ship-angular version
    if (packageJson.dependencies?.['@sixthsummit/ship-angular']) {
      packageJson.dependencies['@sixthsummit/ship-angular'] = placeholders.SHIP_ANGULAR_VERSION;
    }

    // Final pass: substitute {{PLACEHOLDER}} tokens in any string value
    // (e.g. the `serve:ssr` script that points at dist/{{PROJECT_NAME}}/...).
    let serialized = JSON.stringify(packageJson, null, 2) + '\n';
    for (const [key, value] of Object.entries(placeholders)) {
      const placeholder = `{{${key}}}`;
      serialized = serialized.replace(new RegExp(escapeRegExp(placeholder), 'g'), value);
    }
    await fs.writeFile(packageJsonPath, serialized);
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️  Could not process package.json: ${error.message}`));
  }
}

async function processAngularJson(projectPath, placeholders) {
  const angularJsonPath = path.join(projectPath, 'angular.json');

  try {
    let content = await fs.readFile(angularJsonPath, 'utf8');

    // Replace placeholders in the raw content
    for (const [key, value] of Object.entries(placeholders)) {
      const placeholder = `{{${key}}}`;
      content = content.replace(new RegExp(escapeRegExp(placeholder), 'g'), value);
    }

    await fs.writeFile(angularJsonPath, content);
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️  Could not process angular.json: ${error.message}`));
  }
}

async function replaceInFile(filePath, placeholders) {
  try {
    let content = await fs.readFile(filePath, 'utf8');

    for (const [key, value] of Object.entries(placeholders)) {
      const placeholder = `{{${key}}}`;
      content = content.replace(new RegExp(escapeRegExp(placeholder), 'g'), value);
    }

    await fs.writeFile(filePath, content);
  } catch (_error) {
    // File might not exist, that's okay
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertCurrentDirectoryIsSafe(projectPath) {
  const existing = (await fs.readdir(projectPath)).filter(
    entry => !['.DS_Store', '.git'].includes(entry)
  );
  if (existing.length > 0) {
    throw new Error(
      '--current-dir requires an empty directory. ShipAngular will not delete or overwrite an existing project.'
    );
  }
}

function toTitleCase(str) {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function getShipAngularVersion() {
  // Read ship-angular's package.json to get current version
  const shipAngularPackageJsonPath = path.join(__dirname, '..', '..', 'package.json');
  const shipAngularPackageJson = JSON.parse(await fs.readFile(shipAngularPackageJsonPath, 'utf8'));
  const currentVersion = shipAngularPackageJson.version;
  const isPrerelease = currentVersion.includes('-'); // e.g., 1.0.0-beta.1

  if (isPrerelease) {
    // For prereleases, use exact version
    return currentVersion;
  }

  // For stable releases, try to get the latest stable version from npm
  try {
    const latestVersion = execSync('pnpm view @sixthsummit/ship-angular version', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return `^${latestVersion}`;
  } catch (_error) {
    // If npm view fails (package not published yet), use current version
    return currentVersion;
  }
}

function printSuccessMessage(projectName, displayName, isCurrentDirectory, templateConfig) {
  console.log(chalk.green(`✅ Project "${projectName}" created successfully!\n`));

  console.log(chalk.cyan(`Next steps:\n`));

  if (!isCurrentDirectory) {
    console.log(chalk.white(`  cd ${projectName}`));
  }

  console.log(chalk.white(`  # Configure Firebase in src/environments/`));
  console.log(chalk.white(`  # Then start the dev server:`));
  console.log(chalk.white(`  pnpm start\n`));

  console.log(chalk.gray(`Documentation: https://github.com/sixthsummit/ship-angular\n`));
}
