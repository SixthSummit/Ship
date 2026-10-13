/**
 * `ng generate @sixthsummit/ship-angular:operation-mutation <name>` schematic.
 *
 * Scaffolds an injectable mutation for one generated HTTP operation. Expected
 * application failures remain typed result values; exceptional transport and
 * protocol failures remain rejected errors.
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
import {
  destinationPath,
  moduleSpecifier,
  schematicName,
  stableOperationId,
  typescriptIdentifier,
} from '../utils/validate-options';

interface OperationMutationOptions {
  name: string;
  operationId?: string;
  contractPackage?: string;
  contractType?: string;
  apiImport?: string;
  path?: string;
}

export function operationMutation(options: OperationMutationOptions): Rule {
  if (!options.name) {
    throw new SchematicsException('ship-angular:operation-mutation — name is required.');
  }
  const name = schematicName(options.name, 'operation-mutation');
  const targetDir = destinationPath(
    options.path ?? 'src/app/mutations',
    'path',
    'operation-mutation'
  );
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const operationId = stableOperationId(
    options.operationId ?? 'accounts.create',
    'operationId',
    'operation-mutation'
  );
  const contractPackage = moduleSpecifier(
    options.contractPackage ?? '@my-org/ship-api-contract',
    'contractPackage',
    'operation-mutation'
  );
  const contractType = typescriptIdentifier(
    options.contractType ?? 'AppContract',
    'contractType',
    'operation-mutation'
  );
  const apiImport = moduleSpecifier(
    options.apiImport ?? '../../api',
    'apiImport',
    'operation-mutation'
  );

  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.mutation.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:operation-mutation — ${target} already exists. Choose a different name.`
        );
      }
      const source = apply(url('./files'), [
        renderTemplates({
          ...strings,
          name: className,
          fileName,
          operationId,
          contractPackage,
          contractType,
          apiImport,
        }),
        move(targetDir),
      ]);
      return mergeWith(source)(tree, context);
    },
    (_tree: Tree, context: SchematicContext) => {
      context.logger.info(
        `✓ ship-angular:operation-mutation — created ${targetDir}/${fileName}.mutation.ts for operation ${operationId}.`
      );
    },
  ]);
}
