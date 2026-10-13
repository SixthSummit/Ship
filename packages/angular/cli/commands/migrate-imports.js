import {
  migrateFrameworkImportsInDirectory,
  renderFrameworkImportMigration,
} from '../migrations/framework-import-migration.js';

export async function runImportMigration(directory = '.', options = {}) {
  const report = await migrateFrameworkImportsInDirectory(directory, {
    includeTests: options.includeTests ?? false,
    write: options.write ?? false,
  });
  process.stdout.write(renderFrameworkImportMigration(report));
  return report;
}
