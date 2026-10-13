#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, '../packages/angular');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'ship-query-package-'));
const archive = path.join(scratch, 'ship-angular.tgz');
let consumer;
let measurementConsumer;
const keep = process.argv.includes('--keep-artifacts');
try {
  execFileSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'conformance/query/vitest.config.mjs', '--coverage'],
    { cwd: root, stdio: 'inherit' }
  );
  execFileSync('pnpm', ['pack', '--out', archive], { cwd: core, stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/verify-query-generator.mjs', archive], {
    cwd: root,
    stdio: 'inherit',
  });
  const output = execFileSync(
    process.execPath,
    ['conformance/query/run-archive.mjs', archive, 'conformance/query/candidate.mjs'],
    { cwd: root, encoding: 'utf8' }
  );
  process.stdout.write(output);
  const receipt = JSON.parse(output.trim().split('\n').at(-1));
  consumer = receipt.destination;
  const measurementDirectory = path.join(scratch, 'measurement');
  const measurementOutput = execFileSync(
    process.execPath,
    ['conformance/query-example/run-measurement.mjs', archive, measurementDirectory],
    { cwd: root, encoding: 'utf8' }
  );
  process.stdout.write(measurementOutput);
  const measurementReceipt = JSON.parse(measurementOutput.trim().split('\n').at(-1));
  measurementConsumer = measurementReceipt.destination;
  const archiveHash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  if (measurementReceipt.archiveSha256 !== archiveHash)
    throw new Error('Packed measurement used a different archive');
  const manifest = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'));
  console.log(
    JSON.stringify({
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      workingTreeChanged:
        execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0,
      package: manifest.version,
      angular: '20.3.33',
      tanstack: '5.104.1',
      typescript: '5.9.3',
      node: process.version,
      archiveSha256: createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      sameArchive: true,
      packedWorkflowMeasurements: 'passed',
      generatedConsumer: 'passed',
      publicTypes: 'passed',
      runtime: 'passed',
      browser: 'passed',
      ...(keep ? { archive, consumer, measurementDirectory, measurementConsumer } : {}),
    })
  );
} finally {
  if (!keep) {
    await rm(scratch, { recursive: true, force: true });
    if (consumer) await rm(consumer, { recursive: true, force: true });
    if (measurementConsumer) await rm(measurementConsumer, { recursive: true, force: true });
  }
}
