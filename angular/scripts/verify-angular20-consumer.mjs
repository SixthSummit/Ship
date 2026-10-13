#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consumerNode = process.env.SHIP_CONSUMER_NODE ?? process.execPath;
if (!path.isAbsolute(consumerNode))
  throw new Error('SHIP_CONSUMER_NODE must be an absolute Node binary path');
const consumerNodeVersion = execFileSync(consumerNode, ['--version'], { encoding: 'utf8' }).trim();
const consumer = await mkdtemp(path.join(os.tmpdir(), 'ship-angular20-consumer-'));
try {
  const archive = process.argv[2] ?? path.join(consumer, 'ship-angular.tgz');
  if (!process.argv[2]) {
    execFileSync('pnpm', ['pack', '--out', archive], {
      cwd: path.join(root, '../packages/angular'),
      stdio: 'pipe',
    });
  }
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || !archive.endsWith('.tgz')) {
    throw new Error('Use a physical framework .tgz archive');
  }
  const contractArchive = path.join(consumer, 'ship-contract.tgz');
  const contractDirectory = await realpath(
    path.join(root, '../packages/angular/node_modules/@sixthsummit/ship-contract')
  );
  execFileSync('pnpm', ['pack', '--out', contractArchive], {
    cwd: contractDirectory,
    stdio: 'pipe',
  });
  const sharedCoreArchive = path.join(consumer, 'ship-core.tgz');
  execFileSync('pnpm', ['pack', '--out', sharedCoreArchive], {
    cwd: await realpath(path.resolve(contractDirectory, '../ship-core')),
    stdio: 'pipe',
  });
  const archiveSha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@sixthsummit/ship-angular': `file:${path.resolve(archive)}`,
        '@angular/core': '20.0.0',
        '@angular/common': '20.0.0',
        '@angular/compiler': '20.0.0',
        '@angular/forms': '20.0.0',
        '@angular/router': '20.0.0',
        '@angular/platform-browser': '20.0.0',
        '@angular/platform-server': '20.0.0',
        '@sixthsummit/ship-contract': `file:${contractArchive}`,
        '@sixthsummit/ship-core': `file:${sharedCoreArchive}`,
        '@tanstack/angular-query-experimental': '5.104.1',
        firebase: '11.10.0',
        rxjs: '7.8.2',
        tslib: '2.8.1',
        zod: '3.25.76',
        'socket.io-client': '4.8.4',
        typescript: '5.8.3',
      },
    })
  );
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'],
    {
      cwd: consumer,
      stdio: 'inherit',
    }
  );
  const installedVersions = {};
  const resolvedConsumer = await realpath(consumer);
  for (const name of [
    '@sixthsummit/ship-angular',
    '@sixthsummit/ship-contract',
    '@sixthsummit/ship-core',
    '@angular/core',
    'typescript',
  ]) {
    const packageDirectory = path.join(consumer, 'node_modules', name);
    const packagePath = await realpath(packageDirectory);
    if (
      (await lstat(packageDirectory)).isSymbolicLink() ||
      !packagePath.startsWith(`${resolvedConsumer}${path.sep}`)
    ) {
      throw new Error(
        `Consumer dependency ${name} must be physically installed inside the consumer`
      );
    }
    installedVersions[name] = JSON.parse(
      await readFile(path.join(packageDirectory, 'package.json'), 'utf8')
    ).version;
  }
  const installedCore = JSON.parse(
    await readFile(
      path.join(consumer, 'node_modules/@sixthsummit/ship-angular/package.json'),
      'utf8'
    )
  );
  if (installedVersions['@angular/core'] !== '20.0.0' || installedVersions.typescript !== '5.8.3') {
    throw new Error('The minimum consumer must use exact Angular 20.0.0 and TypeScript 5.8.3');
  }
  const entries = Object.keys(installedCore.exports).filter(
    name => name !== './package.json' && name !== './eslint'
  );
  await writeFile(
    path.join(consumer, 'public.ts'),
    entries
      .map((entry, index) => {
        const suffix = entry === '.' ? '' : entry.slice(1);
        return `import * as entry${index} from '@sixthsummit/ship-angular${suffix}';\nvoid entry${index};`;
      })
      .join('\n') +
      `\nimport {defineShipReadBinding, createShipQueryKey} from '@sixthsummit/ship-angular/query';
import type {OperationDefinition} from '@sixthsummit/ship-angular/operations';
type Contract = {'record.get':OperationDefinition<{id:number},{200:{title:string}},never>};
const binding=defineShipReadBinding<Contract>()({operationId:'record.get',safety:'safe',variantKey:'v1',inputKey:input=>input.id});
const scope={namespace:'consumer',scopeKey:'public',generation:0};
createShipQueryKey(binding,{id:1},scope,'finite');
// @ts-expect-error wrong read input must remain rejected
createShipQueryKey(binding,{id:'wrong'},scope,'finite');
`
  );
  await writeFile(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      },
      files: ['public.ts'],
    })
  );
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
    cwd: consumer,
    stdio: 'inherit',
  });
  await writeFile(
    path.join(consumer, 'runtime.mjs'),
    `import '@angular/compiler';
import assert from 'node:assert/strict';
import { ChangeDetectionStrategy, Component, InjectionToken, REQUEST, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { INITIAL_CONFIG, platformServer } from '@angular/platform-server';
import { createPolicyClientFromPolicy, createOperationRequestPolicy, createShipClientToken, provideShipOperationBoundary } from '@sixthsummit/ship-angular/operations';
import { defineShipReadBinding, SHIP_QUERY_CONTEXT, provideShipQueryServer, shipQueryOptions } from '@sixthsummit/ship-angular/query';
class ServerHost {}
Component({selector:'minimum-server-host',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,template:''})(ServerHost);
const CLIENT=createShipClientToken('MinimumConsumerClient');
const POLICY=new InjectionToken('MinimumConsumerPolicy');
const binding=defineShipReadBinding()({operationId:'record.get',safety:'safe',variantKey:'minimum.v1',inputKey:input=>input.id});
const platform=platformServer([{provide:INITIAL_CONFIG,useValue:{document:'<html><body><minimum-server-host></minimum-server-host></body></html>',url:'https://consumer.test/'}}]);
const applications=[];
async function requestApplication(scopeKey) {
  let release;
  let started;
  const waiting=new Promise(resolve=>{release=resolve;});
  const transportStarted=new Promise(resolve=>{started=resolve;});
  const transport={async call(){started();await waiting;return {ok:true,status:200,data:{title:scopeKey},headers:{headers:{}}};}};
  const app=await bootstrapApplication(ServerHost,{providers:[
    provideZonelessChangeDetection(),
    {provide:REQUEST,useValue:new Request('https://consumer.test/'+scopeKey)},
    provideShipOperationBoundary(CLIENT,POLICY,context=>{
      const policy=createOperationRequestPolicy({policies:{'record.get':{authentication:'none',safety:'safe',idempotency:'unsupported',replayable:true}}});
      return {client:createPolicyClientFromPolicy(transport,policy,{signal:context.signal}),requestPolicy:policy};
    },{apiBaseUrl:'https://consumer.test',trackPendingTasks:true}),
    provideShipQueryServer({namespace:'consumer',scopeKey}),
  ]},{platformRef:platform});
  applications.push(app);
  await app.whenStable();
  return {app,context:app.injector.get(SHIP_QUERY_CONTEXT),client:app.injector.get(CLIENT),release,transportStarted};
}
try {
  const first=await requestApplication('one');
  const second=await requestApplication('two');
  assert.notEqual(first.context.queryClient,second.context.queryClient);
  assert.equal(first.context.scope.capture().scopeKey,'one');
  assert.equal(second.context.scope.capture().scopeKey,'two');
  const pending=first.context.queryClient.fetchQuery(shipQueryOptions(first.client,binding,{id:1},first.context));
  await first.transportStarted;
  let stable=false;
  const stability=first.app.whenStable().then(()=>{stable=true;});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(stable,false,'actual operation PendingTasks must block SSR stability while transport is held');
  await second.app.whenStable();
  assert.equal(second.context.queryClient.getQueryCache().getAll().length,0,'another request has no shared read cache');
  first.release();
  assert.equal((await pending).data.title,'one');
  await stability;
  assert.equal(stable,true,'SSR stability resumes when the operation settles');
  second.release();
  const other=await second.context.queryClient.fetchQuery(shipQueryOptions(second.client,binding,{id:1},second.context));
  assert.equal(other.data.title,'two');
} finally {
  for(const app of applications.reverse())app.destroy();
  platform.destroy();
}
`
  );
  execFileSync(consumerNode, ['runtime.mjs'], { cwd: consumer, stdio: 'inherit' });
  execFileSync(
    consumerNode,
    ['node_modules/@sixthsummit/ship-angular/cli/ship-angular.js', '--version'],
    {
      cwd: consumer,
      stdio: 'inherit',
    }
  );
  console.log(
    JSON.stringify({
      maintainerNode: process.version,
      consumerNode: consumerNodeVersion,
      archiveSha256,
      installedVersions,
      angular: '20.0.0',
      typescript: '5.8.3',
      publicEntrypoints: entries.length,
      declarationCompatibility: 'passed',
      negativeInput: 'passed',
      requestClientIsolation: 'passed',
      operationPendingTasks: 'blocked while held; stable after settlement',
      unrelatedRequestStability: 'passed',
      publishedCli: 'passed',
      sourceLinks: false,
      optionalContract:
        'physical type-only fixture; contract packages retain their Node >=22 metadata',
      auditScope:
        'historical minimum-version compatibility fixture; workspace audit runs separately',
    })
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
