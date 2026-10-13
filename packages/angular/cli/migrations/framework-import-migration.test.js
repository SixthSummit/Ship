import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  migrateFrameworkImports,
  migrateFrameworkImportsInDirectory,
  renderFrameworkImportMigration,
} from './framework-import-migration.js';

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../angular/conformance/migration/root-imports-prepackage'
);

describe('framework import migration', () => {
  it('plans the safe subset of a frozen pre-migration client without changing it', async () => {
    const file = path.join(fixtureRoot, 'src/app/app.config.ts');
    const before = await readFile(file, 'utf8');

    const report = await migrateFrameworkImportsInDirectory(fixtureRoot);

    expect(report).toMatchObject({
      mode: 'dry-run',
      scannedFiles: 1,
      changedFiles: 1,
      migratedImports: 1,
    });
    expect(report.manual).toEqual([
      {
        file: 'src/app/app.config.ts',
        reasons: [
          'SessionAuthAdapter requires generated operation IDs and cannot be migrated mechanically.',
        ],
      },
    ]);
    await expect(readFile(file, 'utf8')).resolves.toBe(before);
  });

  it('moves FirebaseAuthAdapter while retaining other root imports', () => {
    const result = migrateFrameworkImports(
      "import { AuthService, FirebaseAuthAdapter as FirebaseAdapter, Logger } from '@sixthsummit/ship-angular';\n"
    );

    expect(result).toMatchObject({ changed: true, migratedImports: 1, manualReasons: [] });
    expect(result.source).toBe(
      "import { AuthService, Logger } from '@sixthsummit/ship-angular';\n" +
        "import { FirebaseAuthAdapter as FirebaseAdapter } from '@sixthsummit/ship-angular/firebase-auth';\n"
    );
  });

  it('replaces a single-symbol import and preserves quote and semicolon style', () => {
    const result = migrateFrameworkImports(
      'import { FirebaseAuthAdapter } from "@sixthsummit/ship-angular"\n'
    );

    expect(result.source).toBe(
      'import { FirebaseAuthAdapter } from "@sixthsummit/ship-angular/firebase-auth"\n'
    );
  });

  it('leaves subpath, dynamic, and commented imports unchanged', () => {
    const source = [
      "import { FirebaseAuthAdapter } from '@sixthsummit/ship-angular/firebase-auth';",
      "const lazy = import('@sixthsummit/ship-angular');",
      "// import { FirebaseAuthAdapter } from '@sixthsummit/ship-angular';",
      '',
    ].join('\n');

    expect(migrateFrameworkImports(source)).toMatchObject({ source, changed: false });
  });

  it('reports session auth and unsupported imports without rewriting them', () => {
    const source = [
      "import { SessionAuthAdapter } from '@sixthsummit/ship-angular';",
      'import {',
      '  FirebaseAuthAdapter, // retain this explanation',
      "} from '@sixthsummit/ship-angular';",
      '',
    ].join('\n');
    const result = migrateFrameworkImports(source);

    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
    expect(result.manualReasons).toEqual([
      'SessionAuthAdapter requires generated operation IDs and cannot be migrated mechanically.',
      'FirebaseAuthAdapter import contains comments or unsupported syntax.',
    ]);
  });

  it('is idempotent after migration', () => {
    const first = migrateFrameworkImports(
      "import { AuthService, FirebaseAuthAdapter } from '@sixthsummit/ship-angular';\n"
    );
    const second = migrateFrameworkImports(first.source);

    expect(first.changed).toBe(true);
    expect(second).toMatchObject({ source: first.source, changed: false, migratedImports: 0 });
  });

  it('dry-runs before applying deterministic changes across a directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-import-migration-'));
    await mkdir(path.join(root, 'src'));
    const app = path.join(root, 'src', 'app.ts');
    const test = path.join(root, 'src', 'app.test.ts');
    const source =
      "import { FirebaseAuthAdapter } from '@sixthsummit/ship-angular';\nexport { FirebaseAuthAdapter };\n";
    await writeFile(app, source);
    await writeFile(test, source);

    const dryRun = await migrateFrameworkImportsInDirectory(root);

    expect(dryRun).toMatchObject({
      mode: 'dry-run',
      scannedFiles: 1,
      changedFiles: 1,
      migratedImports: 1,
    });
    await expect(readFile(app, 'utf8')).resolves.toBe(source);

    const applied = await migrateFrameworkImportsInDirectory(root, { write: true });

    expect(applied.mode).toBe('write');
    await expect(readFile(app, 'utf8')).resolves.toContain(
      "from '@sixthsummit/ship-angular/firebase-auth'"
    );
    await expect(readFile(test, 'utf8')).resolves.toBe(source);
  });

  it('renders dry-run, write, manual, and empty reports', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-import-report-'));
    await writeFile(
      path.join(root, 'app.ts'),
      "import { FirebaseAuthAdapter, SessionAuthAdapter } from '@sixthsummit/ship-angular';\n"
    );
    const dryRun = await migrateFrameworkImportsInDirectory(root);
    const applied = await migrateFrameworkImportsInDirectory(root, { write: true });
    const manual = await migrateFrameworkImportsInDirectory(root);
    const empty = await migrateFrameworkImportsInDirectory(
      await mkdtemp(path.join(os.tmpdir(), 'ship-angular-empty-import-report-'))
    );

    expect(renderFrameworkImportMigration(dryRun)).toContain('Would change');
    expect(renderFrameworkImportMigration(dryRun)).toContain('Manual review required');
    expect(renderFrameworkImportMigration(applied)).toContain('Only deterministic entrypoint');
    expect(renderFrameworkImportMigration(manual)).toContain('Manual review required');
    expect(renderFrameworkImportMigration(empty)).toContain(
      'No known root-entrypoint import migrations were found'
    );
  });
});
