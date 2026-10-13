import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditOperationMigration,
  renderMigrationAudit,
  writeMigrationAudit,
} from './operation-migration-audit.js';

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../angular/conformance/migration/synthetic-legacy'
);

describe('operation migration audit', () => {
  it('classifies the synthetic legacy fixture without changing it', async () => {
    const before = await readFile(
      path.join(fixtureRoot, 'src/app/services/records.service.ts'),
      'utf8'
    );

    const report = await auditOperationMigration(fixtureRoot);

    expect(report.schemaVersion).toBe(1);
    expect(report.scannedFiles).toBe(4);
    expect(report.findings.map(finding => finding.code)).toEqual(
      expect.arrayContaining([
        'binary-transport',
        'constructor-http-di',
        'copied-api-client-import',
        'copied-framework-source',
        'credentials-enabled',
        'direct-http-client',
        'legacy-api-call',
        'manual-bearer-header',
        'message-only-error',
        'multipart-transport',
      ])
    );
    expect(
      report.findings.find(
        finding =>
          finding.code === 'legacy-api-call' &&
          finding.file === 'src/app/services/records.service.ts'
      )
    ).toMatchObject({ occurrences: 4, risk: 'high' });
    expect(report.summary.risk.high).toBeGreaterThan(4);
    expect(
      await readFile(path.join(fixtureRoot, 'src/app/services/records.service.ts'), 'utf8')
    ).toBe(before);
  });

  it('produces deterministic relative paths and report text', async () => {
    const first = await auditOperationMigration(fixtureRoot);
    const second = await auditOperationMigration(fixtureRoot);

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(fixtureRoot);
    expect(renderMigrationAudit(first)).toContain(
      'Stable operation IDs, input mappings, declared errors, retry safety, and transport metadata must come from the packed ShipAPI contract'
    );
  });

  it('ignores tests and comments by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-migration-audit-'));
    await writeFile(path.join(root, 'source.ts'), '// new FormData()\nexport const ok = true;\n');
    await writeFile(path.join(root, 'source.test.ts'), 'new FormData();\n');

    const report = await auditOperationMigration(root);
    const withTests = await auditOperationMigration(root, { includeTests: true });

    expect(report.scannedFiles).toBe(1);
    expect(report.findings).toEqual([]);
    expect(withTests.findings).toEqual([
      expect.objectContaining({ code: 'multipart-transport', file: 'source.test.ts' }),
    ]);
  });

  it('reports Hono, provider, resource, policy, schema, protocol, and mutation review work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-migration-patterns-'));
    await writeFile(
      path.join(root, 'migration.ts'),
      [
        "import { HttpInterceptorFn } from '@angular/common/http';",
        "import { hc } from 'hono/client';",
        "import { createResource, provideShipApiClient, withCsrf } from '@sixthsummit/ship-angular';",
        "import { records } from 'drizzle-orm';",
        'const client = hc<App>(baseUrl);',
        'const resource = createResource(() => client.accounts.$get());',
        'const provider = provideShipApiClient(() => client);',
        "if (error.message.includes('NO_USER_RECORD')) throw error;",
        "const stream = new EventSource('/events');",
        "const socket = new WebSocket('wss://api.example.test');",
        'const query = new URLSearchParams();',
        'const body = JSON.stringify(records);',
        'const optimistic = { rollback() {}, reconcile() {} };',
        'export { body, optimistic, provider, query, resource, socket, stream };',
      ].join('\n')
    );

    const report = await auditOperationMigration(root);
    const codes = new Set(report.findings.map(finding => finding.code));

    expect(codes).toEqual(
      new Set([
        'custom-request-policy',
        'custom-serializer',
        'hono-route-client',
        'legacy-resource',
        'legacy-shipapi-provider',
        'message-based-error-branch',
        'optimistic-state',
        'server-schema-import',
        'socket-transport',
        'stream-transport',
      ])
    );
  });

  it('does not follow generated directories or symbolic links', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-migration-excludes-'));
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist', 'generated.ts'), 'new FormData();\n');
    await writeFile(path.join(root, 'source.ts'), 'export const value = true;\n');
    await symlink(path.join(root, 'source.ts'), path.join(root, 'linked.ts'));

    const report = await auditOperationMigration(root);

    expect(report.scannedFiles).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('renders an explicit empty result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-empty-migration-'));
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');

    const report = await auditOperationMigration(root);

    expect(renderMigrationAudit(report)).toContain('No known migration patterns were found');
  });

  it('refuses to overwrite reports unless force is explicit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-migration-report-'));
    const output = path.join(root, 'report.json');

    await expect(writeMigrationAudit(output, '{}\n')).resolves.toBe(output);
    await expect(writeMigrationAudit(output, '{"changed":true}\n')).rejects.toThrow(
      'Refusing to overwrite existing migration report'
    );
    await expect(writeMigrationAudit(output, '{"changed":true}\n', { force: true })).resolves.toBe(
      output
    );
    await expect(readFile(output, 'utf8')).resolves.toBe('{"changed":true}\n');
  });

  it('rejects unreadable input directories', async () => {
    await expect(auditOperationMigration(path.join(fixtureRoot, 'missing'))).rejects.toThrow(
      'Migration audit directory does not exist or is not readable'
    );
  });
});
