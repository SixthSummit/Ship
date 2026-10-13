import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const QUERY_TEST_DEPENDENCIES = Object.freeze({
  '@angular/common': '20.3.33',
  '@angular/compiler': '20.3.33',
  '@angular/core': '20.3.33',
  '@angular/platform-browser': '20.3.33',
  '@angular/platform-server': '20.3.33',
  '@tanstack/angular-query-experimental': '5.104.1',
  rxjs: '7.8.2',
  tslib: '2.8.1',
  typescript: '5.9.3',
  vitest: '5.0.3',
  '@vitest/coverage-v8': '5.0.3',
  vite: '8.3.4',
  playwright: '1.64.0',
  jsdom: '30.1.2',
});

// Public fixture installs must not inherit pnpm config or machine-wide registry auth.
export function archiveInstallEnvironment(destination) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key))
    ),
    NPM_CONFIG_USERCONFIG: path.join(destination, 'npm-user.config'),
    NPM_CONFIG_GLOBALCONFIG: path.join(destination, 'npm-global.config'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  };
}

/** Install an actual archive. No file: directory, source alias, or sibling link is accepted. */
export async function prepareArchiveConsumer({
  archive,
  bridge,
  destination,
  sourceDirectory,
  install = true,
  offline = false,
}) {
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || !archive.endsWith('.tgz'))
    throw new Error('A physical .tgz archive is required');
  const bridgeSource = await readFile(bridge, 'utf8');
  if (!bridgeSource.includes('@sixthsummit/ship-angular/query'))
    throw new Error('Candidate bridge must import the public query entrypoint');
  if (/\b(?:from\s*|import\s*\(\s*|import\s*)['"](?:file:|\/|\.\.\/)/.test(bridgeSource))
    throw new Error('Candidate bridge cannot import source paths');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'npm-user.config'), '');
  await writeFile(path.join(destination, 'npm-global.config'), '');
  await copyFile(archive, path.join(destination, 'ship-angular.tgz'));
  await copyFile(bridge, path.join(destination, 'candidate.mjs'));
  for (const file of [
    'candidate-browser.mjs',
    'candidate-server.mjs',
    'candidate-session.mjs',
    'candidate-ssr-checks.mjs',
    'candidate-wire.mjs',
    'candidate-wire-server.mjs',
    'fixture-server.mjs',
    'http-client.mjs',
    'packed-candidate.test.mjs',
    'packed.vitest.config.mjs',
  ])
    await copyFile(path.join(sourceDirectory, file), path.join(destination, file));
  for (const file of [
    'assert.mjs',
    'fixture-client.mjs',
    'scenarios.mjs',
    'consumer.type-test.ts',
    'session-port.ts',
  ])
    await copyFile(path.join(sourceDirectory, file), path.join(destination, file));
  await writeFile(
    path.join(destination, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          ...QUERY_TEST_DEPENDENCIES,
          '@sixthsummit/ship-angular': 'file:./ship-angular.tgz',
        },
      },
      null,
      2
    )
  );
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
          lib: ['ES2022', 'DOM'],
        },
        include: ['consumer.type-test.ts', 'session-port.ts'],
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(destination, 'run.mjs'),
    "import {createQueryAdapter} from './candidate.mjs';\nimport {runQueryConformance} from './scenarios.mjs';\nconsole.log(JSON.stringify(await runQueryConformance(createQueryAdapter)));\nimport {runCandidateSsrStability} from './candidate-ssr-checks.mjs';\nconsole.log(JSON.stringify(await runCandidateSsrStability()));\n"
  );
  if (install)
    execFileSync(
      'npm',
      [
        'install',
        offline ? '--offline' : '--prefer-offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps',
      ],
      { cwd: destination, stdio: 'inherit', env: archiveInstallEnvironment(destination) }
    );
}

export async function assertPhysicalPackage(destination) {
  const installed = path.join(destination, 'node_modules/@sixthsummit/ship-angular');
  if ((await lstat(installed)).isSymbolicLink())
    throw new Error('Installed package cannot be a source symlink');
  const actual = await realpath(installed);
  const root = await realpath(destination);
  if (!actual.startsWith(`${root}${path.sep}`))
    throw new Error('Installed package escaped the isolated consumer');
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  if (!manifest.exports?.['./query'])
    throw new Error('Archive does not export the query entrypoint');
  return manifest.version;
}
