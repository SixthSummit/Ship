import path from 'node:path';
import {
  auditOperationMigration,
  renderMigrationAudit,
  writeMigrationAudit,
} from '../migrations/operation-migration-audit.js';

export async function runMigrationAudit(directory = '.', options = {}) {
  const report = await auditOperationMigration(directory, {
    includeTests: options.includeTests ?? false,
  });
  const contents =
    options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMigrationAudit(report);

  if (options.output === undefined) {
    process.stdout.write(contents);
    return report;
  }

  const output = await writeMigrationAudit(options.output, contents, {
    force: options.force ?? false,
  });
  process.stdout.write(`Migration audit written to ${path.relative(process.cwd(), output)}\n`);
  return report;
}
