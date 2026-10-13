/**
 * ShipAngular `ng-add` schematic.
 *
 * Run with:
 *   ng add @SixthSummit/Ship@alpha
 *
 * What it does (idempotent):
 *
 * 1. Adds `@SixthSummit/Ship`, `zod`, and (if `withSsr`)
 *    `@angular/ssr` + `@angular/platform-server` + `express` to
 *    `package.json` dependencies.
 * 2. Writes `src/environments/{environment,environment.development,environment.production}.ts`
 *    skeletons if missing.
 * 3. Writes a starter `src/env.ts` exporting a Zod-validated env via
 *    `defineEnv()` from the framework.
 * 4. Schedules the workspace package-manager install.
 *
 * What it does NOT do (yet):
 *
 * - AST-level provider wiring of `app.config.ts`. The Phase 3 minimal
 *   shipping target is to install + scaffold; provider injection is a
 *   Phase 3.x follow-up. The schematic logs the missing wiring as
 *   actionable instructions.
 */
import {
  apply,
  chain,
  mergeWith,
  type Rule,
  template as renderTemplates,
  type SchematicContext,
  type Tree,
  url,
} from '@angular-devkit/schematics';
import { NodePackageInstallTask } from '@angular-devkit/schematics/tasks';

interface NgAddOptions {
  project?: string;
  withSsr?: boolean;
  skipInstall?: boolean;
}

export function ngAdd(options: NgAddOptions = {}): Rule {
  const withSsr = options.withSsr ?? true;
  return chain([
    addPackageDependencies(withSsr),
    scaffoldEnvIfMissing(),
    schedulePostInstall(options.skipInstall ?? false),
    logFollowUp(withSsr),
  ]);
}

function addPackageDependencies(withSsr: boolean): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const pkgPath = '/package.json';
    if (!tree.exists(pkgPath)) {
      throw new Error('ng-add: project package.json not found at root.');
    }
    const pkg = JSON.parse(tree.readText(pkgPath)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    pkg.dependencies = pkg.dependencies ?? {};
    pkg.devDependencies = pkg.devDependencies ?? {};

    // Resolved at runtime from the installed package's own manifest, so the
    // schematic always pins the version it shipped with (no hardcoded drift).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { version } = require('../../package.json') as { version: string };
    pkg.dependencies['@SixthSummit/Ship'] = `^${version}`;
    pkg.dependencies['zod'] = '^3.23.0';

    if (withSsr) {
      pkg.dependencies['@angular/ssr'] = '^20.0.0';
      pkg.dependencies['@angular/platform-server'] = '^20.0.0';
      pkg.dependencies['express'] = '^4.21.0';
      pkg.devDependencies['@types/express'] = '^5.0.0';
    }

    tree.overwrite(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    context.logger.info(
      `✓ ng-add: dependencies updated (zod, @SixthSummit/Ship${
        withSsr ? ', @angular/ssr, @angular/platform-server, express' : ''
      }).`
    );
    return tree;
  };
}

function scaffoldEnvIfMissing(): Rule {
  return (tree: Tree, _context: SchematicContext) => {
    const envFile = '/src/env.ts';
    if (tree.exists(envFile)) return tree;
    const templateSource = apply(url('./files/env'), [renderTemplates({})]);
    return mergeWith(templateSource);
  };
}

function schedulePostInstall(skip: boolean): Rule {
  return (_tree: Tree, context: SchematicContext) => {
    if (!skip) {
      context.addTask(new NodePackageInstallTask());
    }
    return _tree;
  };
}

function logFollowUp(withSsr: boolean): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const lines = [
      'ShipAngular ng-add complete.',
      '',
      'Next steps:',
      '  1. In your app.config.ts, add:',
      "       import { FirebaseAuthAdapter } from '@SixthSummit/Ship/firebase-auth';",
      '       provideHttpClient(withFetch(), withInterceptors([authInterceptor]))',
      '       provideAppInitializer(async () => {',
      '         if (!isPlatformBrowser(inject(PLATFORM_ID))) return;',
      '         const auth = inject(AuthService);',
      '         auth.setAdapter(new FirebaseAuthAdapter());',
      '         await auth.initialize();',
      '       });',
    ];
    if (withSsr) {
      lines.push(
        '  2. Create src/main.server.ts, src/server.ts, src/app/app.config.server.ts,',
        '     and src/app/app.routes.server.ts. See',
        '     https://github.com/SixthSummit/Ship/tree/dev/packages/core/templates/default',
        '     for reference.'
      );
    }
    lines.push(
      '  3. Generate app-owned features with ng generate @SixthSummit/Ship:module <name>.',
      '  4. Read AGENTS.md / packages/core/CLAUDE.md for conventions.'
    );
    context.logger.info(lines.join('\n'));
    return tree;
  };
}
