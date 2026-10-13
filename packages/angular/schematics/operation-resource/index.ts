/**
 * `ng generate @sixthsummit/ship-angular:operation-resource <name>` schematic.
 *
 * Scaffolds an injectable factory for one generated HTTP operation. The app
 * supplies a signal-tracked input factory; the schematic never invents a URL,
 * serializer, response type, error code, or retry policy.
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

interface OperationResourceOptions {
  name: string;
  operationId?: string;
  contractPackage?: string;
  contractType?: string;
  apiImport?: string;
  path?: string;
}

export function operationResource(options: OperationResourceOptions): Rule {
  if (!options.name) {
    throw new SchematicsException('ship-angular:operation-resource — name is required.');
  }
  const name = schematicName(options.name, 'operation-resource');
  const targetDir = destinationPath(
    options.path ?? 'src/app/resources',
    'path',
    'operation-resource'
  );
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const operationId = stableOperationId(
    options.operationId ?? 'accounts.get',
    'operationId',
    'operation-resource'
  );
  const contractPackage = moduleSpecifier(
    options.contractPackage ?? '@my-org/ship-api-contract',
    'contractPackage',
    'operation-resource'
  );
  const contractType = typescriptIdentifier(
    options.contractType ?? 'AppContract',
    'contractType',
    'operation-resource'
  );
  const apiImport = moduleSpecifier(
    options.apiImport ?? '../../api',
    'apiImport',
    'operation-resource'
  );

  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.resource.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:operation-resource — ${target} already exists. Choose a different name.`
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
        `✓ ship-angular:operation-resource — created ${targetDir}/${fileName}.resource.ts for operation ${operationId}.`
      );
    },
  ]);
}
