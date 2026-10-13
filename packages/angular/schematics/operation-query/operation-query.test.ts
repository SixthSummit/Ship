import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callRule, Tree } from '@angular-devkit/schematics';
import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { lastValueFrom } from 'rxjs';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type OperationQueryOptions, operationQuery } from './index';
import { pinQueryDependency } from './pin-query-dependency';

const directory = dirname(fileURLToPath(import.meta.url));
const core = resolve(directory, '../..');
let scratch: string;
let collection: string;
const options: OperationQueryOptions = {
  name: 'account',
  operationId: 'account.get',
  safety: 'safe',
  contractPackage: '@app/contracts',
  contractType: 'AppContract',
  clientTokenImport: '../../api',
  clientToken: 'APP_CLIENT',
  scopeSourceImport: '../../query-context',
  scopeSource: 'APP_QUERY_CONTEXT',
  keyMapperImport: '../../query-keys',
  keyMapper: 'accountInputKey',
  variantKeyImport: '../../query-keys',
  variantKey: 'accountVariant',
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ship-operation-query-'));
  symlinkSync(join(core, 'node_modules'), join(scratch, 'node_modules'));
  mkdirSync(join(scratch, 'utils'));
  writeFileSync(join(scratch, 'package.json'), '{"type":"commonjs"}');
  for (const name of ['operation-query', 'operation-resource']) {
    const target = join(scratch, name);
    mkdirSync(target);
    cpSync(join(core, 'schematics', name, 'files'), join(target, 'files'), { recursive: true });
    cpSync(join(core, 'schematics', name, 'schema.json'), join(target, 'schema.json'));
    const files = name === 'operation-query' ? ['index', 'pin-query-dependency'] : ['index'];
    for (const file of files) {
      const code = readFileSync(join(core, 'schematics', name, `${file}.ts`), 'utf8');
      writeFileSync(
        join(target, `${file}.js`),
        ts.transpileModule(code, {
          fileName: join(core, 'schematics', name, `${file}.ts`),
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            inlineSourceMap: true,
            inlineSources: true,
            sourceRoot: `${join(core, 'schematics', name)}/`,
          },
        }).outputText
      );
    }
  }
  const validator = readFileSync(join(core, 'schematics/utils/validate-options.ts'), 'utf8');
  writeFileSync(
    join(scratch, 'utils/validate-options.js'),
    ts.transpileModule(validator, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
  );
  // The collection is test-only. M6 owns the published registration.
  collection = join(scratch, 'collection.json');
  writeFileSync(
    collection,
    JSON.stringify({
      schematics: {
        'operation-query': {
          factory: './operation-query/index#operationQuery',
          schema: './operation-query/schema.json',
          description: 'fixture',
        },
        'operation-resource': {
          factory: './operation-resource/index#operationResource',
          schema: './operation-resource/schema.json',
          description: 'existing',
        },
      },
    })
  );
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const runner = () => new SchematicTestRunner('query-fixture', collection);

async function runSourceRule(config: OperationQueryOptions, tree: Tree) {
  const running = runner();
  const schematic = running.engine
    .createCollection('query-fixture')
    .createSchematic('operation-query');
  const context = running.engine.createContext(schematic);
  return lastValueFrom(callRule(operationQuery(config), tree, context));
}

function compileGenerated(
  source: string,
  consumer: string,
  badMapper = false
): readonly ts.Diagnostic[] {
  const consumerRoot = mkdtempSync(join(scratch, 'consumer-'));
  const generated = join(consumerRoot, 'account.query.ts');
  writeFileSync(generated, source);
  writeFileSync(join(consumerRoot, 'consumer.ts'), consumer);
  writeFileSync(
    join(consumerRoot, 'app.d.ts'),
    `import { InjectionToken } from '@angular/core';
import type { OperationClient,OperationDefinition } from '@sixthsummit/ship-angular/operations';
import type { ShipQueryContext } from '@sixthsummit/ship-angular/query';
export type AppContract = {
 'account.get':OperationDefinition<{id:number},{200:{title:string}},'MISSING'>;
 'account.stream':OperationDefinition<{id:number},{200:string},never,'stream'>;
 'account.httpStream':OperationDefinition<{id:number},{200:string}> & {stream:{frame:string}};
};
export declare const APP_CLIENT:InjectionToken<OperationClient<AppContract>>;
export declare const APP_QUERY_CONTEXT:InjectionToken<ShipQueryContext>;
export declare const accountInputKey:(input:${badMapper ? '{wrong:string}' : '{id:number}'})=>number;
export declare const accountVariant:null;`
  );
  const operationFixture = join(consumerRoot, 'operations.d.ts');
  writeFileSync(
    operationFixture,
    ['operation-contract', 'operation-client', 'operation-result']
      .map(file => `export * from '${join(core, 'operations/src', file)}';`)
      .join('\n')
  );
  const paths: Record<string, string[]> = {
    '@angular/core': [join(core, 'node_modules/@angular/core')],
    '@tanstack/angular-query-experimental': [
      '/tmp/ship-query-finite-harness/node_modules/@tanstack/angular-query-experimental/dist/index.d.mts',
    ],
    '@sixthsummit/ship-angular/operations': [operationFixture],
    '@sixthsummit/ship-angular/query': [join(directory, 'fixtures/query-public-api.fixture.ts')],
    '@app/contracts': [join(consumerRoot, 'app.d.ts')],
  };
  // A template import is application-owned. Give its explicit relative path a real declaration.
  source = source
    .replaceAll("'../../api'", "'./app'")
    .replaceAll("'../../query-context'", "'./app'")
    .replaceAll("'../../query-keys'", "'./app'");
  writeFileSync(generated, source);
  const program = ts.createProgram([generated, join(consumerRoot, 'consumer.ts')], {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    noEmit: true,
    experimentalDecorators: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths,
  });
  return ts.getPreEmitDiagnostics(program);
}

describe('operation query generator', () => {
  it('executes the actual source rule for explicit setup and default generation', async () => {
    const tree = Tree.empty();
    tree.create('/package.json', '{"private":true}');
    const plain = await runSourceRule(options, tree);
    expect(plain.read('/src/app/queries/account.query.ts')?.toString()).toContain(
      'injectShipQuery'
    );
    const configured = await runSourceRule(
      { ...options, name: 'configured', setupQuery: true },
      plain
    );
    expect(
      JSON.parse(configured.read('/package.json')!.toString()).dependencies[
        '@tanstack/angular-query-experimental'
      ]
    ).toBe('5.104.1');
    await expect(runSourceRule(options, configured)).rejects.toThrow('already exists');
  });
  it('generates typed app-owned bindings and changes only the requested file by default', async () => {
    const tree = Tree.empty();
    const manifest = '{"private":true,"dependencies":{"other":"1.0.0"}}\n';
    tree.create('/package.json', manifest);
    tree.create('/src/app/app.config.ts', 'preserve');
    const executing = runner();
    const result = await executing.runSchematic('operation-query', options, tree);
    expect(result.readContent('/package.json')).toBe(manifest);
    expect(result.readContent('/src/app/app.config.ts')).toBe('preserve');
    expect(result.files).toEqual([
      '/package.json',
      '/src/app/app.config.ts',
      '/src/app/queries/account.query.ts',
    ]);
    const code = result.readContent('/src/app/queries/account.query.ts');
    expect(code).toContain("safety: 'safe'");
    expect(code).toContain('inputKey: mapQueryInputKey');
    expect(code).toContain('variantKey: queryVariantKey');
    expect(code).toContain('inject(QueryContextToken)');
    expect(code).toContain('injectShipQuery(this.client, READ, input, this.context, options)');
    expect(code).toContain('ShipQueryEnvelope<QueryContract, typeof OPERATION>');
    expect(code).not.toMatch(/https?:|fetch\(|cursor|tenantId|scopeKey:/);
    expect(executing.tasks).toEqual([]);
  });

  it('compiles reactive inputs, envelope access, selectors, and reactive option factories', async () => {
    const result = await runner().runSchematic('operation-query', options, Tree.empty());
    const source = result.readContent('/src/app/queries/account.query.ts');
    const diagnostics = compileGenerated(
      source,
      `import {signal} from '@angular/core';
import {AccountQuery} from './account.query';
declare const factory:AccountQuery;
const input=signal<{id:number}|undefined>({id:1});
const query=factory.create(()=>input());
const title:string|undefined=query.data()?.data.title;
const selected=factory.create(()=>input(),{select:envelope=>envelope.data.title});
const selectedTitle:string|undefined=selected.data();
const reactive=factory.create(()=>input(),()=>({select:envelope=>envelope.data.title,staleTime:1000}));
const reactiveTitle:string|undefined=reactive.data();
void title;void selectedTitle;void reactiveTitle;`
    );
    expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  }, 20_000);

  it.each(['missing.operation', 'account.stream', 'account.httpStream'])(
    'rejects incompatible operation %s at consumer compilation',
    async operationId => {
      const result = await runner().runSchematic(
        'operation-query',
        { ...options, operationId },
        Tree.empty()
      );
      expect(
        compileGenerated(result.readContent('/src/app/queries/account.query.ts'), '').length
      ).toBeGreaterThan(0);
    },
    20_000
  );

  it('rejects wrong inputs, protected query options, and incompatible key mappers', async () => {
    const result = await runner().runSchematic('operation-query', options, Tree.empty());
    const source = result.readContent('/src/app/queries/account.query.ts');
    const diagnostics = compileGenerated(
      source,
      `import {AccountQuery} from './account.query';
declare const factory:AccountQuery;
factory.create(()=>({id:'wrong'}));
factory.create(()=>({id:1}),{retry:true});
factory.create(()=>({id:1}),{select:envelope=>envelope.data.missing});`
    );
    expect(diagnostics).toHaveLength(3);
    expect(compileGenerated(source, '', true).length).toBeGreaterThan(0);
  }, 20_000);

  it('pins the exact dependency only after setupQuery opt-in and preserves unrelated manifest contents', async () => {
    const tree = Tree.empty();
    tree.create(
      '/package.json',
      JSON.stringify({
        name: 'app',
        scripts: { build: 'ng build' },
        dependencies: { other: '1.0.0' },
        devDependencies: { tool: '2.0.0' },
      })
    );
    const result = await runner().runSchematic(
      'operation-query',
      { ...options, setupQuery: true },
      tree
    );
    expect(JSON.parse(result.readContent('/package.json'))).toEqual({
      name: 'app',
      scripts: { build: 'ng build' },
      dependencies: { other: '1.0.0', '@tanstack/angular-query-experimental': '5.104.1' },
      devDependencies: { tool: '2.0.0' },
    });
  });

  it('supports a normalized custom destination and prevents overwriting existing files', async () => {
    const result = await runner().runSchematic(
      'operation-query',
      { ...options, name: 'Account Detail', path: 'src/features/queries' },
      Tree.empty()
    );
    expect(result.exists('/src/features/queries/account-detail.query.ts')).toBe(true);
    await expect(
      runner().runSchematic(
        'operation-query',
        { ...options, name: 'Account Detail', path: 'src/features/queries' },
        result
      )
    ).rejects.toThrow('already exists');
  });

  it.each(['contractType', 'clientToken', 'scopeSource', 'keyMapper', 'variantKey'] as const)(
    'rejects invalid %s identifiers',
    field => {
      expect(() => operationQuery({ ...options, [field]: 'invalid()' })).toThrow('identifier');
    }
  );
  it.each([
    'contractPackage',
    'clientTokenImport',
    'scopeSourceImport',
    'keyMapperImport',
    'variantKeyImport',
  ] as const)('rejects unsafe %s module imports', field => {
    expect(() => operationQuery({ ...options, [field]: "@app/contracts'; execute()" })).toThrow();
    expect(() => operationQuery({ ...options, [field]: '@app/' })).toThrow('static module');
  });
  it.each(Object.keys(options))('requires explicit %s configuration', field => {
    expect(() => operationQuery({ ...options, [field]: undefined } as never)).toThrow();
  });
  it.each([
    { safety: 'unsafe' },
    { safety: 'idempotent' },
    { path: '../outside' },
    { name: '../outside' },
    { operationId: 'read();' },
    { setupQuery: 'true' },
  ])('rejects unsafe options', invalid => {
    expect(() => operationQuery({ ...options, ...invalid } as never)).toThrow();
  });

  it('keeps the existing resource output unchanged and adds no Query dependency implicitly', async () => {
    const previous = await runner().runSchematic(
      'operation-resource',
      { name: 'account' },
      Tree.empty()
    );
    const before = previous.readContent('/src/app/resources/account.resource.ts');
    const next = await runner().runSchematic('operation-query', options, previous);
    expect(next.readContent('/src/app/resources/account.resource.ts')).toBe(before);
    expect(before).toContain('createOperationResource(this.client, OPERATION, input, options)');
    expect(before).not.toContain('tanstack');
    expect(next.exists('/package.json')).toBe(false);
  });
});

describe('opt-in dependency preflight', () => {
  it('requires an application manifest and validates it before rendering', async () => {
    await expect(
      runner().runSchematic('operation-query', { ...options, setupQuery: true }, Tree.empty())
    ).rejects.toThrow('requires package.json');
    expect(() => pinQueryDependency(Tree.empty())).toThrow('requires package.json');
  });
  it.each(['invalid JSON', '[]', 'null', '"string"', '{"dependencies":[]}'])(
    'rejects malformed manifests',
    manifest => {
      const tree = Tree.empty();
      tree.create('/package.json', manifest);
      expect(() => pinQueryDependency(tree)).toThrow();
      expect(tree.read('/package.json')?.toString()).toBe(manifest);
    }
  );
  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])(
    'rejects conflicting supported-version ranges in %s',
    field => {
      const tree = Tree.empty();
      tree.create(
        '/package.json',
        JSON.stringify({ [field]: { '@tanstack/angular-query-experimental': '^5.104.1' } })
      );
      expect(() => pinQueryDependency(tree)).toThrow('exact supported version');
    }
  );
  it('accepts the already-pinned candidate and an absent dependency section', () => {
    for (const manifest of [
      {},
      { dependencies: { '@tanstack/angular-query-experimental': '5.104.1' } },
    ]) {
      const tree = Tree.empty();
      tree.create('/package.json', JSON.stringify(manifest));
      expect(
        JSON.parse(pinQueryDependency(tree)).dependencies['@tanstack/angular-query-experimental']
      ).toBe('5.104.1');
    }
  });
});
