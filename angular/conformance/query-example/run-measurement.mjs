#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveInstallEnvironment,
  assertPhysicalPackage,
  prepareArchiveConsumer,
  QUERY_TEST_DEPENDENCIES,
} from '../query/archive-consumer.mjs';

const [archive, evidenceDirectory] = process.argv.slice(2);
if (!archive || !evidenceDirectory)
  throw new Error(
    'Usage: node conformance/query-example/run-measurement.mjs <physical.tgz> <evidence-directory>'
  );
const source = path.dirname(fileURLToPath(import.meta.url));
const querySource = path.resolve(source, '../query');
const destination = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'ship-query-measurement-'))
);
await prepareArchiveConsumer({
  archive: path.resolve(archive),
  bridge: path.join(querySource, 'candidate.mjs'),
  destination,
  sourceDirectory: querySource,
  offline: process.env.SHIP_QUERY_OFFLINE === '1',
});
await assertPhysicalPackage(destination);
execFileSync(
  'npm',
  [
    'install',
    process.env.SHIP_QUERY_OFFLINE === '1' ? '--offline' : '--prefer-offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
    '--save-exact',
    '@types/node@24.13.3',
  ],
  { cwd: destination, stdio: 'inherit', env: archiveInstallEnvironment(destination) }
);
const files = [
  'fixture.ts',
  'workflow.ts',
  'realtime.ts',
  'providers.ts',
  'measurement.packed-test.ts',
];
const sources = {};
for (const file of files) {
  await copyFile(path.join(source, file), path.join(destination, file));
  sources[file] = createHash('sha256')
    .update(await readFile(path.join(source, file)))
    .digest('hex');
}
const versions = {};
for (const name of [
  ...Object.keys(QUERY_TEST_DEPENDENCIES),
  '@types/node',
  '@sixthsummit/ship-angular',
]) {
  versions[name] = JSON.parse(
    await readFile(path.join(destination, 'node_modules', name, 'package.json'), 'utf8')
  ).version;
}
await writeFile(path.join(destination, 'measurement-versions.json'), JSON.stringify(versions));
sources['run-measurement.mjs'] = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest('hex');
await writeFile(
  path.join(destination, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        noEmit: true,
        experimentalDecorators: true,
        lib: ['ES2022', 'DOM'],
        types: ['node'],
      },
      include: files,
    },
    null,
    2
  )
);
await writeFile(
  path.join(destination, 'measurement.vitest.config.mjs'),
  `export default {root:${JSON.stringify(destination)},test:{environment:'jsdom',include:['measurement.packed-test.ts'],testTimeout:10000,coverage:{provider:'v8',include:['fixture.ts','workflow.ts'],reporter:['text','json-summary'],reportsDirectory:'measurement-coverage',thresholds:{statements:80,branches:80,functions:80,lines:80,perFile:true}}}};`
);
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  cwd: destination,
  stdio: 'inherit',
});
execFileSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'measurement.vitest.config.mjs',
    '--coverage',
  ],
  { cwd: destination, stdio: 'inherit', timeout: 60000 }
);
const result = JSON.parse(
  await readFile(path.join(destination, 'measurement-result.json'), 'utf8')
);
const evidence = {
  ...result,
  environment: 'physical npm consumer; Angular OnPush applications in Vitest jsdom',
  identityIsolation: {
    tenantReplacement: 'passed',
    logout: 'passed',
    nonCooperativeLateRead: 'suppressed',
    beforeFrameworkTick: true,
  },
  archive: path.resolve(archive),
  consumer: destination,
  sourceSha256: sources,
  commands: [
    `node conformance/query-example/run-measurement.mjs ${path.resolve(archive)} ${path.resolve(evidenceDirectory)}`,
  ],
  requiredSkips: [],
};
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(
  path.join(evidenceDirectory, 'measurement.json'),
  `${JSON.stringify(evidence, null, 2)}\n`
);
await copyFile(
  path.join(destination, 'measurement-coverage/coverage-summary.json'),
  path.join(evidenceDirectory, 'coverage-summary.json')
);
console.log(
  JSON.stringify({
    destination,
    evidence: path.resolve(evidenceDirectory),
    archiveSha256: result.archiveSha256,
    acceptance: result.acceptance,
  })
);
