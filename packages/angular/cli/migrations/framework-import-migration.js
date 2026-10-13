import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listMigrationSourceFiles, toPosix } from './migration-source-files.js';

const PACKAGE_ROOT = '@sixthsummit/ship-angular';
const FIREBASE_ENTRYPOINT = '@sixthsummit/ship-angular/firebase-auth';
const ROOT_NAMED_IMPORT =
  /^[\t ]*import\s*\{([\s\S]*?)\}[\t ]*from[\t ]*(['"])@sixthsummit\/ship-angular\2[\t ]*;?/gm;
const SESSION_IMPORT =
  /^[\t ]*import\s*\{[\s\S]*?\bSessionAuthAdapter\b[\s\S]*?\}[\t ]*from[\t ]*(['"])@sixthsummit\/ship-angular\1[\t ]*;?/gm;

export function migrateFrameworkImports(source) {
  const manualReasons = [];
  if (SESSION_IMPORT.test(source)) {
    manualReasons.push(
      'SessionAuthAdapter requires generated operation IDs and cannot be migrated mechanically.'
    );
  }
  SESSION_IMPORT.lastIndex = 0;

  let migratedImports = 0;
  const output = source.replace(ROOT_NAMED_IMPORT, (statement, members, quote) => {
    if (!/\bFirebaseAuthAdapter\b/.test(members)) return statement;
    if (/\/\*|\/\//.test(members)) {
      manualReasons.push('FirebaseAuthAdapter import contains comments or unsupported syntax.');
      return statement;
    }

    const parsed = members
      .split(',')
      .map(member => member.trim())
      .filter(Boolean);
    const firebase = parsed.filter(member =>
      /^(?:type\s+)?FirebaseAuthAdapter(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(member)
    );
    if (firebase.length !== 1) {
      manualReasons.push('FirebaseAuthAdapter import contains unsupported syntax.');
      return statement;
    }

    const remaining = parsed.filter(member => member !== firebase[0]);
    const semicolon = statement.trimEnd().endsWith(';') ? ';' : '';
    const lines = [];
    if (remaining.length > 0) {
      lines.push(
        `import { ${remaining.join(', ')} } from ${quote}${PACKAGE_ROOT}${quote}${semicolon}`
      );
    }
    lines.push(`import { ${firebase[0]} } from ${quote}${FIREBASE_ENTRYPOINT}${quote}${semicolon}`);
    migratedImports += 1;
    return lines.join('\n');
  });
  ROOT_NAMED_IMPORT.lastIndex = 0;

  return {
    source: output,
    changed: output !== source,
    migratedImports,
    manualReasons: [...new Set(manualReasons)],
  };
}

export async function migrateFrameworkImportsInDirectory(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  const files = await listMigrationSourceFiles(root, {
    includeTests: options.includeTests ?? false,
  });
  const changes = [];
  const manual = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const result = migrateFrameworkImports(source);
    const relativeFile = toPosix(path.relative(root, file));
    if (result.changed) {
      changes.push({ file: relativeFile, migratedImports: result.migratedImports });
      if (options.write ?? false) await writeFile(file, result.source, 'utf8');
    }
    if (result.manualReasons.length > 0) {
      manual.push({ file: relativeFile, reasons: result.manualReasons });
    }
  }

  return {
    schemaVersion: 1,
    mode: options.write ? 'write' : 'dry-run',
    scannedFiles: files.length,
    changedFiles: changes.length,
    migratedImports: changes.reduce((total, change) => total + change.migratedImports, 0),
    changes,
    manual,
  };
}

export function renderFrameworkImportMigration(report) {
  const lines = [
    'ShipAngular framework import migration',
    `Mode: ${report.mode}`,
    `Scanned files: ${report.scannedFiles}`,
    `Files ${report.mode === 'write' ? 'changed' : 'to change'}: ${report.changedFiles}`,
    `Imports ${report.mode === 'write' ? 'migrated' : 'to migrate'}: ${report.migratedImports}`,
  ];

  if (report.changes.length > 0) {
    lines.push('', report.mode === 'write' ? 'Changed' : 'Would change');
    for (const change of report.changes) lines.push(`  ${change.file}`);
  }
  if (report.manual.length > 0) {
    lines.push('', 'Manual review required');
    for (const item of report.manual) {
      lines.push(`  ${item.file}`);
      for (const reason of item.reasons) lines.push(`    ${reason}`);
    }
  }
  if (report.changedFiles === 0 && report.manual.length === 0) {
    lines.push('', 'No known root-entrypoint import migrations were found.');
  }
  lines.push(
    '',
    report.mode === 'write'
      ? 'Only deterministic entrypoint imports were changed. Review and test the diff.'
      : 'Dry run only. Re-run with --write to apply deterministic entrypoint changes.'
  );
  return `${lines.join('\n')}\n`;
}
