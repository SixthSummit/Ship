/** Generate an application-owned factory over a client-safe operation form binding. */
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
import {
  destinationPath,
  moduleSpecifier,
  schematicName,
  typescriptIdentifier,
} from '../utils/validate-options';

interface OperationFormOptions {
  name: string;
  bindingPackage?: string;
  bindingName?: string;
  path?: string;
}

export function operationForm(options: OperationFormOptions): Rule {
  if (!options.name) {
    throw new SchematicsException('ship-angular:operation-form — name is required.');
  }
  const name = schematicName(options.name, 'operation-form');
  const targetDir = destinationPath(options.path ?? 'src/app/forms', 'path', 'operation-form');
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const bindingPackage = moduleSpecifier(
    options.bindingPackage ?? '@my-org/ship-api-client',
    'bindingPackage',
    'operation-form'
  );
  const bindingName = typescriptIdentifier(
    options.bindingName ?? `${strings.camelize(name)}FormBinding`,
    'bindingName',
    'operation-form'
  );

  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.form.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:operation-form — ${target} already exists. Choose a different name.`
        );
      }
      const source = apply(url('./files'), [
        renderTemplates({ ...strings, name: className, fileName, bindingPackage, bindingName }),
        move(targetDir),
      ]);
      return mergeWith(source)(tree, context);
    },
    (_tree: Tree, context: SchematicContext) => {
      context.logger.info(
        `✓ ship-angular:operation-form — created ${targetDir}/${fileName}.form.ts from a client-safe generated binding.`
      );
    },
  ]);
}
