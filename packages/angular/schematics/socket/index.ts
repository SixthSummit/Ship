/** Generate an injectable factory over a generated operation socket binding. */
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

interface SocketOptions {
  name: string;
  bindingPackage?: string;
  bindingName?: string;
  apiImport?: string;
  path?: string;
}

export function socket(options: SocketOptions): Rule {
  if (!options.name) throw new SchematicsException('ship-angular:socket — name is required.');
  const name = schematicName(options.name, 'socket');
  const targetDir = destinationPath(options.path ?? 'src/app/services', 'path', 'socket');
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const bindingPackage = moduleSpecifier(
    options.bindingPackage ?? '@my-org/ship-api-client',
    'bindingPackage',
    'socket'
  );
  const bindingName = typescriptIdentifier(
    options.bindingName ?? `${strings.camelize(name)}SocketBinding`,
    'bindingName',
    'socket'
  );
  const apiImport = moduleSpecifier(options.apiImport ?? '../../api', 'apiImport', 'socket');

  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.socket.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:socket — ${target} already exists. Choose a different name.`
        );
      }
      const source = apply(url('./files'), [
        renderTemplates({
          ...strings,
          name: className,
          fileName,
          bindingPackage,
          bindingName,
          apiImport,
        }),
        move(targetDir),
      ]);
      return mergeWith(source)(tree, context);
    },
    (_tree: Tree, context: SchematicContext) => {
      context.logger.info(
        `✓ ship-angular:socket — created ${targetDir}/${fileName}.socket.ts. Pass exact approved socket origins when creating a connection.`
      );
    },
  ]);
}
