#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(repo, '../packages/angular');
const archive = process.argv[2];
if (!archive?.endsWith('.tgz')) throw new Error('Pass the physical ShipAngular .tgz archive');
const consumer = await mkdtemp(path.join(os.tmpdir(), 'ship-query-generator-'));
try {
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@sixthsummit/ship-angular': `file:${path.resolve(archive)}`,
        '@tanstack/angular-query-experimental': '5.104.1',
        ...Object.fromEntries(
          [
            '@angular/core',
            '@angular/common',
            '@angular/compiler',
            '@angular/router',
            'zod',
            'rxjs',
            'tslib',
            'typescript',
            '@angular-devkit/core',
            '@angular-devkit/schematics',
          ].map(name => [name, `link:${path.join(core, 'node_modules', name)}`])
        ),
      },
    })
  );
  execFileSync(
    'pnpm',
    [
      'install',
      process.env.SHIP_QUERY_OFFLINE === '1' ? '--offline' : '--prefer-offline',
      '--ignore-scripts',
      '--config.auto-install-peers=false',
    ],
    { cwd: consumer, stdio: 'inherit' }
  );
  const require = createRequire(path.join(consumer, 'package.json'));
  const { SchematicTestRunner } = require('@angular-devkit/schematics/testing');
  const { Tree } = require('@angular-devkit/schematics');
  const installed = path.join(consumer, 'node_modules/@sixthsummit/ship-angular');
  const runner = new SchematicTestRunner(
    'ship-angular',
    path.join(installed, 'schematics/collection.json')
  );
  const base = {
    name: 'account',
    operationId: 'account.get',
    safety: 'safe',
    contractPackage: './contract',
    contractType: 'Contract',
    clientTokenImport: './bindings',
    clientToken: 'CLIENT',
    scopeSourceImport: './bindings',
    scopeSource: 'CONTEXT',
    keyMapperImport: './bindings',
    keyMapper: 'inputKey',
    variantKeyImport: './bindings',
    variantKey: 'variant',
  };
  const tree = await runner.runSchematic('operation-query', base, Tree.empty());
  const directory = path.join(consumer, 'src/app/queries');
  await mkdir(directory, { recursive: true });
  for (const file of tree.files) {
    const target = path.join(consumer, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, tree.read(file));
  }
  await writeFile(
    path.join(directory, 'contract.ts'),
    `import type {OperationDefinition} from '@sixthsummit/ship-angular/operations';\nexport interface Contract {'account.get':OperationDefinition<{id:number},{200:{name:string}},never>;}\n`
  );
  await writeFile(
    path.join(directory, 'bindings.ts'),
    `import {InjectionToken} from '@angular/core';\nimport type {OperationClient} from '@sixthsummit/ship-angular/operations';\nimport {SHIP_QUERY_CONTEXT} from '@sixthsummit/ship-angular/query';\nimport type {Contract} from './contract';\nexport const CLIENT = new InjectionToken<OperationClient<Contract>>('client');\nexport const CONTEXT = SHIP_QUERY_CONTEXT;\nexport const inputKey = (input:{id:number}) => ({id:input.id});\nexport const variant = 'public.v1';\n`
  );
  await writeFile(
    path.join(directory, 'consumer.ts'),
    `import {signal} from '@angular/core';\nimport {AccountQuery} from './account.query';\ndeclare const query:AccountQuery;\nconst id=signal(1);\nconst result=query.create(()=>({id:id()}),{select:envelope=>envelope.data.name});\nconst name:string|undefined=result.data();\nvoid name;\n// @ts-expect-error wrong operation input\nquery.create(()=>({id:'bad'}));\n// @ts-expect-error caller cannot replace retry ownership\nquery.create(()=>({id:1}),{retry:3});\n`
  );
  await writeFile(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        skipLibCheck: false,
        experimentalDecorators: true,
        lib: ['ES2022', 'DOM'],
      },
      include: ['src/**/*.ts'],
    })
  );
  const exampleDirectory = path.join(consumer, 'src/example');
  await mkdir(exampleDirectory, { recursive: true });
  for (const file of ['fixture.ts', 'workflow.ts', 'realtime.ts', 'providers.ts']) {
    await writeFile(
      path.join(exampleDirectory, file),
      await readFile(path.join(repo, 'conformance/query-example', file))
    );
  }
  const tsc = path.join(core, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: consumer, stdio: 'inherit' });
  const generated = path.join(directory, 'account.query.ts');
  const valid = await readFile(generated, 'utf8');
  await writeFile(generated, valid.replace("'account.get'", "'missing.operation'"));
  let rejected = false;
  try {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: consumer, stdio: 'pipe' });
  } catch (error) {
    const diagnostic = String(error.stdout);
    if (!diagnostic.includes('missing.operation')) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error('Generated invalid operation ID was accepted');
  console.log(
    JSON.stringify({
      archive: path.resolve(archive),
      generatedFactory: 'physical package',
      types: 'passed',
      packedGuideExample: 'passed',
      selectorInference: true,
      negativeInputs: true,
      protectedRetry: true,
      invalidOperationRejected: true,
    })
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
