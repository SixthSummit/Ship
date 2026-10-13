/**
 * `ng generate @sixthsummit/ship-angular:auth-adapter <name>` schematic.
 *
 * Scaffolds a custom AuthAdapter implementation with all required methods
 * stubbed and a companion `.test.ts` that imports the adapter and runs the
 * framework's `runConformance` suite. The in-memory scaffold passes before
 * provider integration; preserve those transitions while replacing its bodies.
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

interface AuthAdapterOptions {
  name: string;
  path?: string;
}

export function authAdapter(options: AuthAdapterOptions): Rule {
  if (!options.name) throw new SchematicsException('ship-angular:auth-adapter — name is required.');
  const targetDir = (options.path ?? 'src/auth').replace(/^\/+/, '');
  const className = strings.classify(options.name);
  const fileName = strings.dasherize(className);

  return chain([
    (tree: Tree, _ctx: SchematicContext) => {
      const target = `${targetDir}/${fileName}.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:auth-adapter — ${target} already exists. Choose a different name or remove first.`
        );
      }
      const templateSource = apply(url('./files'), [
        renderTemplates({ ...strings, name: className, fileName }),
        move(targetDir),
      ]);
      return mergeWith(templateSource)(tree, _ctx);
    },
    (_tree: Tree, ctx: SchematicContext) => {
      ctx.logger.info(
        `✓ ship-angular:auth-adapter — created ${targetDir}/${fileName}.ts and ${targetDir}/${fileName}.test.ts. Run \`pnpm test\` to verify the conformance suite passes.`
      );
    },
  ]);
}
