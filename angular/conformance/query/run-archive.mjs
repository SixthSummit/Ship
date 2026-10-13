#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPhysicalPackage, prepareArchiveConsumer } from './archive-consumer.mjs';

const [archive, bridge] = process.argv.slice(2);
if (!archive || !bridge)
  throw new Error(
    'Usage: node conformance/query/run-archive.mjs <physical.tgz> <candidate-bridge.mjs>'
  );
const destination = await mkdtemp(path.join(os.tmpdir(), 'ship-query-archive-'));
await prepareArchiveConsumer({
  archive: path.resolve(archive),
  bridge: path.resolve(bridge),
  destination,
  offline: process.env.SHIP_QUERY_OFFLINE === '1',
  sourceDirectory: path.dirname(fileURLToPath(import.meta.url)),
});
const version = await assertPhysicalPackage(destination);
execFileSync(
  process.execPath,
  [path.join(destination, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
  { cwd: destination, stdio: 'inherit' }
);
execFileSync(process.execPath, ['run.mjs'], { cwd: destination, stdio: 'inherit', timeout: 60000 });
execFileSync(
  process.execPath,
  [
    path.join(destination, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'packed.vitest.config.mjs',
    '--coverage',
  ],
  { cwd: destination, stdio: 'inherit', timeout: 60000 }
);
execFileSync(
  process.execPath,
  [path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-browser.mjs'), destination],
  { stdio: 'inherit', timeout: 60000 }
);
console.log(
  JSON.stringify({
    archive: path.resolve(archive),
    version,
    destination,
    types: 'passed',
    candidateCoverage: 'passed',
    chromium: 'passed',
    ssrStability: 'passed',
    sourceLinks: false,
  })
);
