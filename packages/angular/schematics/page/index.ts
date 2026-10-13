/**
 * `ng generate @sixthsummit/ship-angular:page <module> <name>` schematic.
 *
 * Scaffolds a standalone, OnPush, signal-first page component under
 * `src/app/modules/<module>/pages/<name>/`. Adds an entry to `<module>/routes.ts`
 * mounting the page at `/{path-or-name}`.
 */
import { strings } from '@angular-devkit/core';
import {
  apply,
  chain,
  mergeWith,
  move,
  type Rule,
  template as renderTemplates,
  type SchematicContext,
  SchematicsException,
  type Tree,
  url,
} from '@angular-devkit/schematics';

interface PageOptions {
  module: string;
  name: string;
  path?: string;
  guarded?: boolean;
}

export function page(options: PageOptions): Rule {
  if (!options.module) throw new SchematicsException('ship-angular:page — module is required.');
  if (!options.name) throw new SchematicsException('ship-angular:page — name is required.');
  const moduleName = strings.dasherize(options.module);
  const pageName = strings.dasherize(options.name);
  const routePath = options.path ?? pageName;
  const guarded = options.guarded ?? false;

  return chain([
    scaffoldPageFiles(moduleName, pageName),
    injectIntoModuleRoutes(moduleName, pageName, routePath, guarded),
    logSummary(moduleName, pageName),
  ]);
}

function scaffoldPageFiles(moduleName: string, pageName: string): Rule {
  return (tree: Tree) => {
    const target = `src/app/modules/${moduleName}/pages/${pageName}`;
    const dir = tree.getDir(target);
    if (dir.subfiles.length > 0) {
      throw new SchematicsException(
        `ship-angular:page — ${target}/ already exists. Choose a different name or remove first.`
      );
    }
    if (!tree.exists(`/src/app/modules/${moduleName}/module.json`)) {
      throw new SchematicsException(
        `ship-angular:page — src/app/modules/${moduleName}/ does not exist. Run 'ng g @sixthsummit/ship-angular:module ${moduleName}' first.`
      );
    }
    const templateSource = apply(url('./files'), [
      renderTemplates({ ...strings, name: pageName, moduleName }),
      move(target),
    ]);
    return mergeWith(templateSource);
  };
}

function injectIntoModuleRoutes(
  moduleName: string,
  pageName: string,
  routePath: string,
  guarded: boolean
): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const routesPath = `/src/app/modules/${moduleName}/routes.ts`;
    if (!tree.exists(routesPath)) {
      context.logger.warn(
        `ship-angular:page — ${routesPath} not found; skipping route injection. Wire the page manually.`
      );
      return tree;
    }
    const source = tree.readText(routesPath);
    const componentName = `${strings.classify(pageName)}Component`;
    const importPath = `./pages/${pageName}/${pageName}.component`;
    const guardSnippet = guarded ? '\n    canActivate: [authGuard],' : '';
    const newRoute = `  {
    path: '${routePath}',${guardSnippet}
    loadComponent: () => import('${importPath}').then(m => m.${componentName}),
  },\n`;

    // Ensure authGuard is imported when needed.
    let next = source;
    if (guarded && !/from '@sixthsummit\/ship-angular'/.test(next)) {
      next = `import { authGuard } from '@sixthsummit/ship-angular';\n${next}`;
    } else if (guarded) {
      next = next.replace(/import \{ ([^}]*) \} from '@sixthsummit\/ship-angular';/, (m, names) => {
        const list = names.split(',').map((s: string) => s.trim());
        if (!list.includes('authGuard')) list.push('authGuard');
        return `import { ${list.join(', ')} } from '@sixthsummit/ship-angular';`;
      });
    }

    const arrayMatch = next.match(/(export const \w+Routes\s*:?\s*Routes\s*=\s*\[)/);
    if (!arrayMatch) {
      context.logger.warn(
        `ship-angular:page — couldn't find the Routes array in ${routesPath}; the page file is created but not wired. Add the route by hand.`
      );
      return tree;
    }
    const idx = arrayMatch.index! + arrayMatch[0].length;
    next = next.slice(0, idx) + '\n' + newRoute + next.slice(idx);
    tree.overwrite(routesPath, next);
    context.logger.info(`✓ Wired ${componentName} into ${routesPath} (mounted at /${routePath}).`);
    return tree;
  };
}

function logSummary(moduleName: string, pageName: string): Rule {
  return (_tree: Tree, context: SchematicContext) => {
    context.logger.info(
      `✓ ship-angular:page — created src/app/modules/${moduleName}/pages/${pageName}/${pageName}.component.ts`
    );
  };
}
