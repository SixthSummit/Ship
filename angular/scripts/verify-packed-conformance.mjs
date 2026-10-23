#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJointBrowser } from './verify-joint-browser.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const fixtureRoot = path.join(repositoryRoot, 'conformance', 'shipapi-fixture');
const consumerSourceRoot = path.join(repositoryRoot, 'conformance', 'packed-consumer');
const corePackageRoot = path.join(repositoryRoot, '..', 'packages', 'angular');
const argumentsSet = new Set(process.argv.slice(2));
const keepArtifacts = argumentsSet.has('--keep-artifacts');
const requireExternal = argumentsSet.has('--require-external');
const manifestFlagIndex = process.argv.indexOf('--manifest');
const manifestArgument =
  manifestFlagIndex === -1
    ? (process.env.SHIP_API_CONFORMANCE_MANIFEST ??
      (requireExternal ? 'conformance/joint/artifacts/manifest.json' : undefined))
    : process.argv[manifestFlagIndex + 1];

const forbiddenRuntimePackages = [
  '@sixthsummit/ship-api',
  '@hono/',
  'hono',
  'drizzle-orm',
  'drizzle-zod',
  'firebase-admin',
  'pg',
  'postgres',
  '@opentelemetry/sdk-node',
];

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ship-angular-conformance-'));

try {
  assertBuiltCore();

  const coreArtifact = await packPackage(
    corePackageRoot,
    path.join(temporaryRoot, 'ship-angular.tgz')
  );
  const fixture = await acquireFixture();

  const coreScan = await scanArchive(coreArtifact, {
    label: '@sixthsummit/ship-angular',
    compiledOnly: true,
    requiredFiles: [
      'package/lib/index.d.ts',
      'package/lib/operations/index.d.ts',
      'package/lib/query/index.d.ts',
      'package/lib/fesm2022/sixthsummit-ship-angular-query.mjs',
      'package/lib/ship-api/index.d.ts',
      'package/lib/testing/index.d.ts',
      'package/lib/hono-v4/index.d.ts',
      'package/lib/legacy-rest/index.d.ts',
      'package/lib/auth/index.d.ts',
      'package/lib/firebase-auth/index.d.ts',
      'package/lib/download/index.d.ts',
      'package/lib/upload/index.d.ts',
      'package/lib/stream/index.d.ts',
      'package/lib/socket/index.d.ts',
      'package/lib/realtime/index.d.ts',
      'package/lib/push/index.d.ts',
      'package/lib/fesm2022/sixthsummit-ship-angular-push.mjs',
      'package/lib/storage/index.d.ts',
      'package/lib/fesm2022/sixthsummit-ship-angular-storage.mjs',
      'package/lib/console/index.d.ts',
      'package/lib/fesm2022/sixthsummit-ship-angular-console.mjs',
      'package/lib/credential-auth/index.d.ts',
      'package/lib/fesm2022/sixthsummit-ship-angular-credential-auth.mjs',
      'package/lib/forms/index.d.ts',
      'package/eslint/index.js',
      'package/eslint/index.d.ts',
      'package/cli/commands/audit-migration.js',
      'package/cli/commands/migrate-imports.js',
      'package/cli/migrations/framework-import-migration.js',
      'package/cli/migrations/migration-source-files.js',
      'package/cli/migrations/operation-migration-audit.js',
      'package/schematics/collection.json',
      'package/schematics/operation-query/index.js',
      'package/schematics/operation-query/schema.json',
      'package/schematics/operation-query/files/__fileName__.query.ts',
      'package/schematics/operation-resource/index.js',
      'package/schematics/operation-resource/schema.json',
      'package/schematics/operation-resource/files/__fileName__.resource.ts',
      'package/schematics/operation-mutation/index.js',
      'package/schematics/operation-mutation/schema.json',
      'package/schematics/operation-mutation/files/__fileName__.mutation.ts',
      'package/schematics/operation-auth/index.js',
      'package/schematics/operation-auth/schema.json',
      'package/schematics/operation-auth/files/__fileName__.session-auth.ts',
      'package/schematics/download/index.js',
      'package/schematics/download/schema.json',
      'package/schematics/download/files/__fileName__.download.ts',
      'package/schematics/socket/index.js',
      'package/schematics/socket/schema.json',
      'package/schematics/socket/files/__fileName__.socket.ts',
      'package/schematics/signed-upload/index.js',
      'package/schematics/signed-upload/schema.json',
      'package/schematics/signed-upload/files/__fileName__.signed-upload.ts',
      'package/schematics/operation-form/index.js',
      'package/schematics/operation-form/schema.json',
      'package/schematics/operation-form/files/__fileName__.form.ts',
    ],
  });
  const contractScan = await scanArchive(fixture.contractPackage.tarball, {
    label: fixture.contractPackage.name,
    compiledOnly: false,
    requiredFiles: ['package/index.d.ts', 'package/index.js'],
  });
  const clientScan = await scanArchive(fixture.clientPackage.tarball, {
    label: fixture.clientPackage.name,
    compiledOnly: false,
    requiredFiles: ['package/index.d.ts', 'package/index.js'],
  });

  const runtimeReport = await runPackedConsumer(coreArtifact, fixture);
  if (runtimeReport.fixtureProtocolVersion !== fixture.fixtureProtocolVersion) {
    throw new Error(
      `Fixture protocol mismatch: manifest=${fixture.fixtureProtocolVersion}, runtime=${runtimeReport.fixtureProtocolVersion}`
    );
  }
  if (runtimeReport.graphHash !== fixture.graphHash) {
    throw new Error(
      `Fixture graph hash mismatch: manifest=${fixture.graphHash}, runtime=${runtimeReport.graphHash}`
    );
  }

  const report = {
    ...(fixture.producer ? { consumedManifest: fixture } : {}),
    fixtureSource:
      manifestArgument === undefined ? 'synthetic-packed-fixture' : 'external-manifest',
    fixtureProtocolVersion: fixture.fixtureProtocolVersion,
    graphHash: fixture.graphHash,
    wireFixtureVersion: fixture.wireFixtureVersion,
    packages: {
      shipAngular: await artifactReport('@sixthsummit/ship-angular', coreArtifact, coreScan),
      contract: await artifactReport(
        fixture.contractPackage.name,
        fixture.contractPackage.tarball,
        contractScan
      ),
      client: await artifactReport(
        fixture.clientPackage.name,
        fixture.clientPackage.tarball,
        clientScan
      ),
    },
    optionalQueryPeerAbsent: runtimeReport.optionalQueryPeerAbsent,
    runtime: runtimeReport.report,
  };

  console.log('\nPacked conformance passed');
  console.log(JSON.stringify(report, null, 2));
  if (keepArtifacts) console.log(`Artifacts retained at ${temporaryRoot}`);
} finally {
  if (!keepArtifacts) await fs.rm(temporaryRoot, { recursive: true, force: true });
}

function assertBuiltCore() {
  const entry = path.join(corePackageRoot, 'lib', 'fesm2022', 'sixthsummit-ship-angular.mjs');
  if (!existsSync(entry)) {
    throw new Error('Packed conformance requires a fresh core build. Run `pnpm build` first.');
  }
  if (requireExternal && manifestArgument === undefined) {
    throw new Error(
      'Joint conformance requires --manifest <path> or SHIP_API_CONFORMANCE_MANIFEST; the synthetic fixture is not accepted.'
    );
  }
  if (manifestFlagIndex !== -1 && manifestArgument === undefined) {
    throw new Error('--manifest requires a path argument');
  }
}

async function acquireFixture() {
  if (manifestArgument !== undefined) return loadExternalManifest(manifestArgument);

  const sourceManifest = JSON.parse(
    await fs.readFile(path.join(fixtureRoot, 'manifest.source.json'), 'utf8')
  );
  const contractTarball = await packPackage(
    path.join(fixtureRoot, sourceManifest.contractPackage.source),
    path.join(temporaryRoot, 'ship-api-contract.tgz')
  );
  const clientTarball = await packPackage(
    path.join(fixtureRoot, sourceManifest.clientPackage.source),
    path.join(temporaryRoot, 'ship-api-client.tgz')
  );

  return {
    fixtureProtocolVersion: sourceManifest.fixtureProtocolVersion,
    graphHash: sourceManifest.graphHash,
    wireFixtureVersion: sourceManifest.wireFixtureVersion,
    contractPackage: {
      ...sourceManifest.contractPackage,
      tarball: contractTarball,
      sha256: await sha256File(contractTarball),
    },
    clientPackage: {
      ...sourceManifest.clientPackage,
      tarball: clientTarball,
      sha256: await sha256File(clientTarball),
    },
  };
}

async function loadExternalManifest(file) {
  const manifestPath = path.resolve(repositoryRoot, file);
  const manifestDirectory = path.dirname(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  assertPositiveInteger(manifest.fixtureProtocolVersion, 'fixtureProtocolVersion');
  assertPositiveInteger(manifest.wireFixtureVersion, 'wireFixtureVersion');
  if (typeof manifest.graphHash !== 'string' || !manifest.graphHash.startsWith('sha256:')) {
    throw new Error('External conformance manifest graphHash must use the sha256:<digest> form');
  }
  if (manifest.producer) {
    const artifactSetHash = `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          graphHash: manifest.graphHash,
          artifacts: [
            manifest.contractPackage,
            manifest.clientPackage,
            manifest.serverPackage,
            ...(manifest.dependencies ?? []),
          ].map(({ name, version, sha256 }) => ({ name, version, sha256 })),
        })
      )
      .digest('hex')}`;
    if (artifactSetHash !== manifest.artifactSetHash)
      throw new Error('Joint artifact-set fingerprint mismatch');
  }

  return {
    ...manifest,
    ...(manifest.serverPackage
      ? {
          serverPackage: await resolveManifestPackage(
            manifest.serverPackage,
            manifestDirectory,
            'serverPackage'
          ),
        }
      : {}),
    dependencies: await Promise.all(
      (manifest.dependencies ?? []).map(specification =>
        resolveManifestPackage(specification, manifestDirectory, 'dependency')
      )
    ),
    contractPackage: await resolveManifestPackage(
      manifest.contractPackage,
      manifestDirectory,
      'contractPackage'
    ),
    clientPackage: await resolveManifestPackage(
      manifest.clientPackage,
      manifestDirectory,
      'clientPackage'
    ),
  };
}

async function resolveManifestPackage(specification, baseDirectory, key) {
  if (
    typeof specification?.name !== 'string' ||
    typeof specification?.version !== 'string' ||
    typeof specification?.tarball !== 'string' ||
    typeof specification?.sha256 !== 'string'
  ) {
    throw new Error(`${key} must declare name, version, tarball, and sha256`);
  }
  const tarball = path.resolve(baseDirectory, specification.tarball);
  const digest = await sha256File(tarball);
  if (digest !== stripShaPrefix(specification.sha256)) {
    throw new Error(
      `${key} checksum mismatch: expected ${specification.sha256}, received ${digest}`
    );
  }
  const packedManifest = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })
  );
  if (
    packedManifest.name !== specification.name ||
    packedManifest.version !== specification.version
  )
    throw new Error(`${key} package name/version does not match its manifest`);
  return { ...specification, tarball };
}

async function packPackage(directory, output) {
  execFileSync('pnpm', ['pack', '--out', output], {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output;
}

async function scanArchive(archive, options) {
  const extractionDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'extract-'));
  execFileSync('tar', ['-xzf', archive, '-C', extractionDirectory]);
  const packageDirectory = path.join(extractionDirectory, 'package');
  const files = await listFiles(packageDirectory);
  const archiveFiles = files.map(file => path.relative(extractionDirectory, file));

  for (const required of options.requiredFiles) {
    if (!archiveFiles.includes(required)) {
      throw new Error(`${options.label} tarball is missing required public artifact ${required}`);
    }
  }
  if (archiveFiles.some(file => file.startsWith('package/src/'))) {
    throw new Error(`${options.label} tarball leaks package source files`);
  }
  if (archiveFiles.some(file => file.startsWith('package/modules/'))) {
    throw new Error(`${options.label} tarball still contains the retired module catalog`);
  }

  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  );
  verifyRuntimeDependencies(options.label, manifest);
  verifyExportTargets(options.label, packageDirectory, manifest.exports);

  const scanFiles = files.filter(file => {
    const relative = path.relative(packageDirectory, file);
    if (options.compiledOnly) {
      return relative.startsWith('lib/fesm2022/') || relative.endsWith('.d.ts');
    }
    return /\.(?:js|mjs|cjs|d\.ts)$/.test(relative);
  });
  for (const file of scanFiles) {
    const source = await fs.readFile(file, 'utf8');
    for (const specifier of extractModuleSpecifiers(source)) {
      if (isForbiddenSpecifier(specifier)) {
        throw new Error(
          `${options.label} browser artifact imports forbidden runtime package ${specifier} in ${path.relative(packageDirectory, file)}`
        );
      }
    }
  }
  if (options.label === '@sixthsummit/ship-angular') {
    const rootRuntime = await fs.readFile(
      path.join(packageDirectory, 'lib', 'fesm2022', 'sixthsummit-ship-angular.mjs'),
      'utf8'
    );
    const rootSpecifiers = extractModuleSpecifiers(rootRuntime);
    if ([...rootSpecifiers].some(specifier => specifier.includes('@tanstack/'))) {
      throw new Error('ShipAngular root runtime imports optional TanStack code');
    }
    if (
      rootSpecifiers.has('@angular/fire/auth') ||
      [...rootSpecifiers].some(
        specifier => specifier === 'firebase' || specifier.startsWith('firebase/')
      )
    ) {
      throw new Error('ShipAngular root runtime imports optional Firebase authentication code');
    }
  }

  return { files: files.length, scannedFiles: scanFiles.length };
}

function verifyRuntimeDependencies(label, manifest) {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (isForbiddenSpecifier(name)) {
        throw new Error(`${label} declares forbidden ${field} entry ${name}`);
      }
      if (/^(?:file|link|workspace):/.test(String(range))) {
        throw new Error(`${label} declares non-portable ${field} range ${name}@${range}`);
      }
    }
  }
}

function verifyExportTargets(label, packageDirectory, exportsMap) {
  if (exportsMap === undefined) throw new Error(`${label} does not declare package exports`);
  const visit = value => {
    if (typeof value === 'string' && value.startsWith('./')) {
      const target = path.join(packageDirectory, value);
      if (!existsSync(target)) throw new Error(`${label} exports missing target ${value}`);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(exportsMap);
}

function extractModuleSpecifiers(source) {
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found = new Set();
  const expression = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of executableSource.matchAll(expression)) found.add(match[1]);
  return found;
}

function isForbiddenSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true;
  return forbiddenRuntimePackages.some(
    forbidden => specifier === forbidden || specifier.startsWith(`${forbidden}/`)
  );
}

async function runPackedConsumer(coreArtifact, fixture) {
  const consumerRoot = path.join(temporaryRoot, 'consumer');
  await fs.mkdir(consumerRoot, { recursive: true });
  const runtimeDependencyArtifacts = {};
  for (const dependency of ['chalk', 'commander', 'tslib']) {
    runtimeDependencyArtifacts[dependency] = await packPackage(
      path.join(corePackageRoot, 'node_modules', dependency),
      path.join(temporaryRoot, `${dependency}.tgz`)
    );
  }

  const replacements = new Map([
    [
      '@sixthsummit/ship-api-conformance-contract',
      fixture.contractPackage.import ?? fixture.contractPackage.name,
    ],
    [
      '@sixthsummit/ship-api-conformance-client',
      fixture.clientPackage.import ?? fixture.clientPackage.name,
    ],
  ]);
  const joint = fixture.producer?.repository === 'SixthSummit/Ship';
  if (requireExternal && (!joint || !fixture.serverPackage))
    throw new Error('Joint gate requires a ShipAPI producer and packed fixture server');
  for (const file of joint
    ? ['valid-consumer.ts', 'runtime.mjs', 'browser.ts']
    : ['valid-consumer.ts', 'invalid-consumer.ts', 'documented-boundary.ts', 'runtime.mjs']) {
    let source = await fs.readFile(
      path.join(joint ? path.join(repositoryRoot, 'conformance/joint') : consumerSourceRoot, file),
      'utf8'
    );
    for (const [original, replacement] of replacements) {
      source = source.replaceAll(original, replacement);
    }
    await fs.writeFile(path.join(consumerRoot, file), source);
  }

  await fs.writeFile(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'ship-angular-packed-conformance-consumer',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          ...(joint
            ? {
                '@angular/platform-server': `link:${path.dirname(fileURLToPath(import.meta.resolve('@angular/platform-server/package.json')))}`,
                '@angular/platform-browser': `link:${path.join(corePackageRoot, 'node_modules/@angular/platform-browser')}`,
                [fixture.serverPackage.name]: `file:${fixture.serverPackage.tarball}`,
                '@angular/forms': `link:${path.join(corePackageRoot, 'node_modules/@angular/forms')}`,
              }
            : {}),
          ...Object.fromEntries(
            (fixture.dependencies ?? []).map(spec => [spec.name, `file:${spec.tarball}`])
          ),
          '@angular/common': `link:${path.join(corePackageRoot, 'node_modules', '@angular', 'common')}`,
          '@angular/compiler': `link:${path.join(corePackageRoot, 'node_modules', '@angular', 'compiler')}`,
          '@angular/core': `link:${path.join(corePackageRoot, 'node_modules', '@angular', 'core')}`,
          '@angular/router': `link:${path.join(corePackageRoot, 'node_modules', '@angular', 'router')}`,
          '@sixthsummit/ship-angular': `file:${coreArtifact}`,
          // /ship-api uses ShipAPI's canonical client type only in declarations.
          // Its runtime bundle remains import-free; packed consumers still need the type peer.
          '@sixthsummit/ship-contract': `link:${path.join(corePackageRoot, 'node_modules', '@sixthsummit', 'ship-contract')}`,
          [fixture.contractPackage.name]: `file:${fixture.contractPackage.tarball}`,
          [fixture.clientPackage.name]: `file:${fixture.clientPackage.tarball}`,
          chalk: `file:${runtimeDependencyArtifacts.chalk}`,
          commander: `file:${runtimeDependencyArtifacts.commander}`,
          rxjs: `link:${path.join(corePackageRoot, 'node_modules', 'rxjs')}`,
          tslib: `file:${runtimeDependencyArtifacts.tslib}`,
          zod: `link:${path.join(corePackageRoot, 'node_modules', 'zod')}`,
        },
        pnpm: {
          overrides: {
            ...Object.fromEntries(
              (fixture.dependencies ?? []).map(spec => [spec.name, `file:${spec.tarball}`])
            ),
            chalk: `file:${runtimeDependencyArtifacts.chalk}`,
            commander: `file:${runtimeDependencyArtifacts.commander}`,
            tslib: `file:${runtimeDependencyArtifacts.tslib}`,
          },
        },
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(
    path.join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM'],
          module: 'ES2022',
          moduleResolution: 'bundler',
          noEmit: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
          verbatimModuleSyntax: true,
        },
        include: ['*.ts'],
      },
      null,
      2
    )}\n`
  );

  execFileSync(
    'pnpm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--config.auto-install-peers=false',
      '--config.strict-peer-dependencies=true',
    ],
    { cwd: consumerRoot, stdio: 'inherit' }
  );

  // The packages under test come only from tarballs. The manifest links ordinary peers from
  // the root's registry install so this clean consumer can rerun without network access.
  const optionalQueryPeer = path.join(
    consumerRoot,
    'node_modules/@tanstack/angular-query-experimental'
  );
  if (existsSync(optionalQueryPeer)) throw new Error('Root/operations proof must omit TanStack');
  const coreNodeModules = path.join(corePackageRoot, 'node_modules');
  execFileSync(
    'node',
    [path.join(coreNodeModules, 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    {
      cwd: consumerRoot,
      stdio: 'inherit',
    }
  );
  const output = execFileSync('node', ['runtime.mjs'], {
    cwd: consumerRoot,
    encoding: 'utf8',
  }).trim();
  const report = JSON.parse(output);
  report.optionalQueryPeerAbsent = true;
  if (joint) report.report.browser = await runJointBrowser(consumerRoot);
  return report;
}

async function artifactReport(name, tarball, scan) {
  const stats = await fs.stat(tarball);
  return {
    name,
    sha256: `sha256:${await sha256File(tarball)}`,
    bytes: stats.size,
    files: scan.files,
    scannedFiles: scan.scannedFiles,
  };
}

async function sha256File(file) {
  const contents = await fs.readFile(file);
  return createHash('sha256').update(contents).digest('hex');
}

function stripShaPrefix(value) {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
