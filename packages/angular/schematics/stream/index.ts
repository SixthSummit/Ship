/**
 * `ng generate @sixthsummit/ship-angular:stream <name>` schematic.
 *
 * Scaffolds an Angular service over a generated operation stream binding.
 * The binding owns URL serialization, declared statuses, and event decoding.
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

interface StreamOptions {
  name: string;
  operationId?: string;
  contractPackage?: string;
  contractType?: string;
  bindingPackage?: string;
  bindingName?: string;
  apiImport?: string;
  path?: string;
}

export function stream(options: StreamOptions): Rule {
  if (!options.name) throw new SchematicsException('ship-angular:stream — name is required.');
  const name = schematicName(options.name, 'stream');
  const targetDir = destinationPath(options.path ?? 'src/app/services', 'path', 'stream');
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const operationId = stableOperationId(
    options.operationId ?? 'events.watch',
    'operationId',
    'stream'
  );
  const contractPackage = moduleSpecifier(
    options.contractPackage ?? '@my-org/ship-api-contract',
    'contractPackage',
    'stream'
  );
  const contractType = typescriptIdentifier(
    options.contractType ?? 'AppContract',
    'contractType',
    'stream'
  );
  const bindingPackage = moduleSpecifier(
    options.bindingPackage ?? '@my-org/ship-api-client',
    'bindingPackage',
    'stream'
  );
  const bindingName = typescriptIdentifier(
    options.bindingName ?? `${strings.camelize(name)}StreamBinding`,
    'bindingName',
    'stream'
  );
  const apiImport = moduleSpecifier(options.apiImport ?? '../../api', 'apiImport', 'stream');

  return chain([
    (tree: Tree, _ctx: SchematicContext) => {
      const target = `${targetDir}/${fileName}.service.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:stream — ${target} already exists. Choose a different name.`
        );
      }
      const templateSource = apply(url('./files'), [
        renderTemplates({
          ...strings,
          name: className,
          fileName,
          operationId,
          contractPackage,
          contractType,
          bindingPackage,
          bindingName,
          apiImport,
        }),
        move(targetDir),
      ]);
      return mergeWith(templateSource)(tree, _ctx);
    },
    (_tree: Tree, ctx: SchematicContext) => {
      ctx.logger.info(
        `✓ ship-angular:stream — created ${targetDir}/${fileName}.service.ts for operation ${operationId}.`
      );
    },
  ]);
}
