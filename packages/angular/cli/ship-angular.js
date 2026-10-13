#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runMigrationAudit } from './commands/audit-migration.js';
import { createProject } from './commands/create.js';
import { runDoctor } from './commands/doctor.js';
import { runImportMigration } from './commands/migrate-imports.js';
import { updateProject } from './commands/update.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const version = packageJson.version;

const program = new Command();

program
  .name('ship-angular')
  .description(
    'ShipAngular Framework CLI - Build modern Angular applications with Firebase authentication'
  )
  .version(version);

program
  .command('create <project-name>')
  .description('Create a new ShipAngular project')
  .option('-t, --template <template>', 'Project template to use', 'default')
  .option('--current-dir', 'Install in current directory instead of creating new directory')
  .option('--skip-install', 'Skip pnpm install after project creation')
  .option('--skip-git', 'Skip git initialization')
  .action(async (projectName, options) => {
    try {
      await createProject(projectName, options);
    } catch (error) {
      console.error('Error creating project:', error.message);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Update an existing ShipAngular project to the latest framework version')
  .option('-f, --force', 'Force update even if there are conflicts')
  .action(async options => {
    try {
      await updateProject(options);
    } catch (error) {
      console.error('Error updating project:', error.message);
      process.exit(1);
    }
  });

program
  .command('audit-migration [directory]')
  .description(
    'Generate a non-mutating operation-client migration inventory for an Angular application'
  )
  .option('--format <format>', 'Report format: text or json', 'text')
  .option('-o, --output <file>', 'Write the report without overwriting an existing file')
  .option('--force', 'Allow --output to overwrite an existing report')
  .option('--include-tests', 'Include *.test.* and *.spec.* files in the inventory')
  .action(async (directory, options) => {
    try {
      if (!['json', 'text'].includes(options.format)) {
        throw new Error('--format must be either text or json');
      }
      await runMigrationAudit(directory, options);
    } catch (error) {
      console.error('Migration audit failed:', error.message);
      process.exitCode = 1;
    }
  });

program
  .command('migrate-imports [directory]')
  .description('Move deterministic framework imports to their new package entrypoints')
  .option('--write', 'Apply safe import changes; the default is a dry run')
  .option('--include-tests', 'Include *.test.* and *.spec.* files')
  .action(async (directory, options) => {
    try {
      await runImportMigration(directory, options);
    } catch (error) {
      console.error('Import migration failed:', error.message);
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description(
    'Health-check an existing ShipAngular project (version drift, missing providers, SSR misconfig)'
  )
  .action(async () => {
    try {
      await runDoctor();
    } catch (error) {
      console.error('Error running doctor:', error.message);
      process.exit(1);
    }
  });

program.parse();
