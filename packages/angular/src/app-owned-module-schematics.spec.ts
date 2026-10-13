import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tree } from '@angular-devkit/schematics';
import { SchematicTestRunner, UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeEach, describe, expect, it } from 'vitest';

const schematicsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'schematics');
const collectionPath = join(schematicsRoot, 'collection.json');
const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'default');

describe('app-owned feature schematics', () => {
  let runner: SchematicTestRunner;
  let app: UnitTestTree;

  beforeEach(() => {
    runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    app = new UnitTestTree(Tree.empty());
    app.create(
      '/src/app/app.routes.ts',
      "import { type Routes } from '@angular/router';\n\nexport const routes: Routes = [];\n"
    );
  });

  it('generates feature code inside the consumer application', async () => {
    const result = await runner.runSchematic(
      'module',
      { name: 'order-history', description: 'Order history', guarded: true },
      app
    );

    expect(result.exists('/src/app/modules/order-history/module.json')).toBe(true);
    expect(result.exists('/src/app/modules/order-history/routes.ts')).toBe(true);
    expect(result.exists('/modules/order-history/module.json')).toBe(false);
    expect(result.readContent('/src/app/app.routes.ts')).toContain(
      "from './modules/order-history/routes'"
    );
    expect(result.readContent('/src/app/modules/order-history/routes.ts')).toContain(
      'canActivate: [authGuard]'
    );
  });

  it('adds pages to an app-owned module and its route table', async () => {
    const withModule = await runner.runSchematic('module', { name: 'orders' }, app);
    const result = await runner.runSchematic(
      'page',
      { module: 'orders', name: 'detail', path: 'orders/:orderId', guarded: true },
      withModule
    );

    expect(result.exists('/src/app/modules/orders/pages/detail/detail.component.ts')).toBe(true);
    const routes = result.readContent('/src/app/modules/orders/routes.ts');
    expect(routes).toContain("path: 'orders/:orderId'");
    expect(routes).toContain('canActivate: [authGuard]');
    expect(routes).toContain("import { authGuard } from '@sixthsummit/ship-angular'");
  });

  it('refuses to place a page outside an existing app-owned module', async () => {
    await expect(
      runner.runSchematic('page', { module: 'missing', name: 'detail' }, app)
    ).rejects.toThrow('src/app/modules/missing/ does not exist');
  });
});

describe('schematic template rendering', () => {
  const cases = [
    {
      schematic: 'api-client',
      options: {},
      file: '/src/api.ts',
    },
    {
      schematic: 'auth-adapter',
      options: { name: 'ExampleAuthAdapter' },
      file: '/src/auth/example-auth-adapter.ts',
    },
    {
      schematic: 'operation-resource',
      options: { name: 'account-detail' },
      file: '/src/app/resources/account-detail.resource.ts',
    },
    {
      schematic: 'operation-mutation',
      options: { name: 'create-account' },
      file: '/src/app/mutations/create-account.mutation.ts',
    },
    {
      schematic: 'operation-auth',
      options: { name: 'app' },
      file: '/src/auth/app.session-auth.ts',
    },
    {
      schematic: 'stream',
      options: { name: 'activity' },
      file: '/src/app/services/activity.service.ts',
    },
    {
      schematic: 'download',
      options: { name: 'invoice' },
      file: '/src/app/services/invoice.download.ts',
    },
    {
      schematic: 'socket',
      options: { name: 'notifications' },
      file: '/src/app/services/notifications.socket.ts',
    },
    {
      schematic: 'upload',
      options: { name: 'avatar-upload' },
      file: '/src/app/components/avatar-upload.component.ts',
    },
    {
      schematic: 'signed-upload',
      options: { name: 'archive' },
      file: '/src/app/services/archive.signed-upload.ts',
    },
    {
      schematic: 'operation-form',
      options: { name: 'account' },
      file: '/src/app/forms/account.form.ts',
    },
  ] as const;

  for (const fixture of cases) {
    it(`renders ${fixture.schematic} source instead of shipping template tokens`, async () => {
      const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
      const result = await runner.runSchematic(
        fixture.schematic,
        fixture.options,
        new UnitTestTree(Tree.empty())
      );

      expect(result.exists(fixture.file)).toBe(true);
      expect(result.readContent(fixture.file)).not.toMatch(/<%[=-]?/);
    });
  }

  it('renders the target operation-client provider without Hono coupling', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'api-client',
      {
        contractPackage: '@example/contracts',
        contractType: 'ExampleContract',
        cookieNames: ['session'],
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/api.ts');

    expect(source).toContain("from '@sixthsummit/ship-angular/operations'");
    expect(source).toContain("import type { ExampleContract } from '@example/contracts'");
    expect(source).toContain('cookieNames: ["session"]');
    expect(source).toContain('provideShipOperationBoundary(APP_SHIP_CLIENT');
    expect(source).toContain('APP_SHIP_REQUEST_POLICY');
    expect(source).toContain('injectAppShipRequestPolicy');
    expect(source).not.toContain('hc<');
    expect(source).not.toContain('provideShipApiClient');
  });

  it('generates capability-based auth adapters with colocated Vitest conformance', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'auth-adapter',
      { name: 'ExampleAuthAdapter' },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/auth/example-auth-adapter.ts');

    expect(source).toContain('readonly capabilities: AuthAdapterCapabilities');
    expect(source).toContain('readonly initialize');
    expect(source).not.toContain('signInWithPopup(_provider');
    expect(result.exists('/src/auth/example-auth-adapter.test.ts')).toBe(true);
    expect(result.exists('/src/auth/example-auth-adapter.spec.ts')).toBe(false);
  });

  it('generates an explicit typed operation stream without URL or thunk probing', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'stream',
      {
        name: 'agent-chat',
        operationId: 'agent.chat.stream',
        contractPackage: '@example/contracts',
        bindingPackage: '@example/client',
        bindingName: 'agentChatBinding',
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/app/services/agent-chat.service.ts');

    expect(source).toContain('createOperationStream');
    expect(source).toContain("'agent.chat.stream' as const");
    expect(source).toContain("from '@sixthsummit/ship-angular/stream'");
    expect(source).toContain('injectAppShipRequestPolicy');
    expect(source).not.toContain('createStream');
    expect(source).not.toContain("'/api/");
  });

  it('generates a typed operation resource factory without transport guesses', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'operation-resource',
      {
        name: 'account-detail',
        operationId: 'accounts.get',
        contractPackage: '@example/contracts',
        contractType: 'ExampleContract',
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/app/resources/account-detail.resource.ts');

    expect(source).toContain('createOperationResource');
    expect(source).toContain("'accounts.get' as const");
    expect(source).toContain('InputOf<ExampleContract, typeof OPERATION>');
    expect(source).toContain('injectAppShipClient');
    expect(source).not.toContain('createResource(');
    expect(source).not.toContain('hc<');
    expect(source).not.toContain("'/api/");
    expect(source).not.toMatch(/\bany\b/);
  });

  it('generates a typed operation mutation with declared failures left as values', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'operation-mutation',
      {
        name: 'create-account',
        operationId: 'accounts.create',
        contractPackage: '@example/contracts',
        contractType: 'ExampleContract',
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/app/mutations/create-account.mutation.ts');

    expect(source).toContain('createOperationMutation');
    expect(source).toContain("'accounts.create' as const");
    expect(source).toContain('OperationMutation<ExampleContract, typeof OPERATION>');
    expect(source).toContain('injectAppShipClient');
    expect(source).not.toContain('ApiError');
    expect(source).not.toContain('.message');
    expect(source).not.toMatch(/\bany\b/);
  });

  it('generates operation-backed session auth without identity casts or hidden requests', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'operation-auth',
      {
        name: 'customer',
        meOperationId: 'identity.current',
        signInOperationId: 'identity.login',
        registerOperationId: 'identity.register',
        signOutOperationId: 'identity.logout',
        refreshOperationId: '',
        contractPackage: '@example/contracts',
        contractType: 'ExampleContract',
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/auth/customer.session-auth.ts');

    expect(source).toContain('OperationSessionAuthAdapter<ExampleContract>');
    expect(source).toContain("operation: 'identity.current'");
    expect(source).toContain("operation: 'identity.register'");
    expect(source).toContain('SessionAuthOperationMap<ExampleContract>');
    expect(source).toContain("'client' | 'operations'");
    expect(source).toContain('(value: unknown) => AuthUser');
    expect(source).not.toContain('auth.refresh');
    expect(source).not.toContain('fetch(');
    expect(source).not.toMatch(/\bas\s+AuthUser\b/);
    expect(source).not.toMatch(/\bany\b/);
  });

  it('rejects invalid operation IDs before rendering auth source', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);

    await expect(
      runner.runSchematic(
        'operation-auth',
        { name: 'customer', meOperationId: "auth.me'; runUnexpected()" },
        new UnitTestTree(Tree.empty())
      )
    ).rejects.toThrow('meOperationId must be a stable operation ID');
  });

  it.each([
    ['operation-resource', { name: 'account', operationId: "accounts.get'; injected()" }],
    ['operation-mutation', { name: 'account', contractType: 'AppContract | unknown' }],
    ['operation-auth', { name: 'account', contractPackage: "@example/contracts'; injected()" }],
    ['stream', { name: 'activity', bindingName: 'activityBinding()' }],
    ['upload', { name: 'avatar', fieldName: 'file-name' }],
    ['download', { name: 'invoice', operationId: "invoice.pdf'; injected()" }],
    ['socket', { name: 'notifications', bindingName: 'socketBinding()' }],
    ['signed-upload', { name: 'archive', path: '../outside' }],
    ['operation-form', { name: 'account', bindingPackage: "@example/forms'; injected()" }],
    ['api-client', { path: '../../outside' }],
  ])('rejects unsafe %s interpolation options', async (schematic, options) => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);

    await expect(
      runner.runSchematic(schematic, options, new UnitTestTree(Tree.empty()))
    ).rejects.toThrow(/must be/);
  });

  it('rejects unsupported download representations', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);

    await expect(
      runner.runSchematic(
        'download',
        { name: 'invoice', representation: 'text' },
        new UnitTestTree(Tree.empty())
      )
    ).rejects.toThrow();
  });

  it('refuses to overwrite operation resource, mutation, and auth files', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const resource = await runner.runSchematic(
      'operation-resource',
      { name: 'account' },
      new UnitTestTree(Tree.empty())
    );
    const mutation = await runner.runSchematic(
      'operation-mutation',
      { name: 'account' },
      new UnitTestTree(Tree.empty())
    );
    const auth = await runner.runSchematic(
      'operation-auth',
      { name: 'account' },
      new UnitTestTree(Tree.empty())
    );

    await expect(
      runner.runSchematic('operation-resource', { name: 'account' }, resource)
    ).rejects.toThrow('account.resource.ts already exists');
    await expect(
      runner.runSchematic('operation-mutation', { name: 'account' }, mutation)
    ).rejects.toThrow('account.mutation.ts already exists');
    await expect(runner.runSchematic('operation-auth', { name: 'account' }, auth)).rejects.toThrow(
      'account.session-auth.ts already exists'
    );
  });

  it('generates a typed operation upload using shared policy and binding constraints', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'upload',
      {
        name: 'avatar-upload',
        operationId: 'accounts.avatar.upload',
        contractPackage: '@example/contracts',
        bindingPackage: '@example/client',
        bindingName: 'avatarUploadBinding',
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/app/components/avatar-upload.component.ts');

    expect(source).toContain('createOperationUpload');
    expect(source).toContain("'accounts.avatar.upload' as const");
    expect(source).toContain('injectAppShipRequestPolicy');
    expect(source).toContain('avatarUploadBinding.fields');
    expect(source).toContain('upload.cancel()');
    expect(source).not.toContain('createUpload');
    expect(source).not.toContain('new XMLHttpRequest');
  });

  it('generates a lossless operation download with explicit representation and cleanup', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'download',
      {
        name: 'invoice',
        operationId: 'invoices.pdf',
        representation: 'arrayBuffer',
        contractPackage: '@example/contracts',
        contractType: 'ExampleContract',
        bindingPackage: '@example/client',
        bindingName: 'invoiceDownloadBinding',
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/app/services/invoice.download.ts');

    expect(source).toContain("'invoices.pdf' as const");
    expect(source).toContain("typeof OPERATION, 'arrayBuffer'");
    expect(source).toContain('invoiceDownloadBinding');
    expect(source).toContain('injectAppShipRequestPolicy');
    expect(source).toContain('this.download.destroy()');
    expect(source).not.toContain('responseType');
    expect(source).not.toContain("'/api/");
  });

  it('generates socket and signed-upload factories with required origin policy options', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const socket = await runner.runSchematic(
      'socket',
      {
        name: 'notifications',
        bindingPackage: '@example/client',
        bindingName: 'notificationsSocketBinding',
      },
      new UnitTestTree(Tree.empty())
    );
    const signedUpload = await runner.runSchematic(
      'signed-upload',
      {
        name: 'archive',
        bindingPackage: '@example/client',
        bindingName: 'archiveSignedUploadBinding',
      },
      new UnitTestTree(Tree.empty())
    );
    const socketSource = socket.readContent('/src/app/services/notifications.socket.ts');
    const signedUploadSource = signedUpload.readContent(
      '/src/app/services/archive.signed-upload.ts'
    );

    expect(socketSource).toContain('create(options: CreateOperationSocketOptions)');
    expect(socketSource).toContain('notificationsSocketBinding, options');
    expect(socketSource).not.toContain('allowedSocketOrigins: []');
    expect(socketSource).not.toContain('new WebSocket');
    expect(signedUploadSource).toContain('create(options: CreateOperationSignedUploadOptions)');
    expect(signedUploadSource).toContain('archiveSignedUploadBinding, options');
    expect(signedUploadSource).not.toContain('allowedProviderOrigins: []');
    expect(signedUploadSource).not.toContain('Authorization');
  });

  it('generates operation forms only from a client-safe binding', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const result = await runner.runSchematic(
      'operation-form',
      {
        name: 'account-profile',
        bindingPackage: '@example/client',
        bindingName: 'accountProfileFormBinding',
      },
      new UnitTestTree(Tree.empty())
    );
    const source = result.readContent('/src/app/forms/account-profile.form.ts');

    expect(source).toContain('createOperationForm(accountProfileFormBinding)');
    expect(source).toContain("from '@sixthsummit/ship-angular/forms'");
    expect(source).not.toContain('drizzle');
    expect(source).not.toContain('zod');
    expect(source).not.toMatch(/\bany\b/);
  });

  it('renders ng-add environment source', async () => {
    const runner = new SchematicTestRunner('@sixthsummit/ship-angular', collectionPath);
    const app = new UnitTestTree(Tree.empty());
    app.create('/package.json', JSON.stringify({ dependencies: {} }));
    const result = await runner.runSchematic('ng-add', { skipInstall: true }, app);

    expect(result.exists('/src/env.ts')).toBe(true);
    expect(result.readContent('/src/env.ts')).not.toMatch(/<%[=-]?/);
  });
});

describe('generated application package-manager contract', () => {
  it('uses pnpm consistently in the manifest and build tools', () => {
    const manifest = JSON.parse(readFileSync(join(templateRoot, 'package.json'), 'utf8')) as {
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    expect(manifest.packageManager).toMatch(/^pnpm@/);
    // The scoped Vitest peer correction covers application builds plus Analog tests.
    // It must not silently opt a scaffold into Angular's experimental native test runner.
    expect(readFileSync(join(templateRoot, 'angular.json'), 'utf8')).not.toContain(
      '@angular/build:unit-test'
    );
    expect(manifest.scripts?.ci).toContain('pnpm ');
    expect(readFileSync(join(templateRoot, 'Dockerfile'), 'utf8')).toContain(
      'pnpm install --frozen-lockfile'
    );
    expect(readFileSync(join(templateRoot, 'playwright.config.ts'), 'utf8')).toContain(
      "command: 'pnpm start --port 4200'"
    );
  });

  const bootstrap =
    'npm install --prefix "$RUNNER_TEMP/ship-pnpm" --no-audit --no-fund --ignore-scripts pnpm@10.34.6';

  function assertPnpmWorkflow(source: string, workflow: string) {
    expect(source, workflow).toContain(bootstrap);
    // Only installation of the pinned package-manager binary may use npm.
    // Application dependency, script, and audit commands must still use pnpm.
    expect(source.replaceAll(bootstrap, ''), workflow).not.toMatch(
      /\bnpm\s+(?:ci|install|run|test|exec|audit|outdated|view)\b|\bnpx\s+\S+/
    );
    expect(source, workflow).not.toContain("cache: 'npm'");
  }

  it('bootstraps pinned pnpm and uses it for generated application commands', () => {
    const workflowRoot = join(templateRoot, '.github', 'workflows');
    const workflows = readdirSync(workflowRoot).filter(name => name.endsWith('.yml'));
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      assertPnpmWorkflow(readFileSync(join(workflowRoot, workflow), 'utf8'), workflow);
    }
  });

  it('rejects application commands while allowing only the exact pinned bootstrap', () => {
    expect(() => assertPnpmWorkflow(bootstrap, 'bootstrap fixture')).not.toThrow();
    for (const command of ['npx vitest', 'npm ci', 'npm run test', 'npm audit']) {
      expect(() => assertPnpmWorkflow(`${bootstrap}\n${command}`, 'negative fixture')).toThrow();
    }
    expect(() =>
      assertPnpmWorkflow(bootstrap.replace('10.34.6', '11.19.0'), 'wrong pin')
    ).toThrow();
  });
});
