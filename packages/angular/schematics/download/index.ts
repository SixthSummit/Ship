/** Generate an Angular service over a generated operation download binding. */
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

interface DownloadOptions {
  name: string;
  operationId?: string;
  representation?: 'blob' | 'arrayBuffer' | 'stream';
  contractPackage?: string;
  contractType?: string;
  bindingPackage?: string;
  bindingName?: string;
  apiImport?: string;
  path?: string;
}

export function download(options: DownloadOptions): Rule {
  if (!options.name) throw new SchematicsException('ship-angular:download — name is required.');
  const name = schematicName(options.name, 'download');
  const targetDir = destinationPath(options.path ?? 'src/app/services', 'path', 'download');
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const operationId = stableOperationId(
    options.operationId ?? 'documents.download',
    'operationId',
    'download'
  );
  const representation = options.representation ?? 'blob';
  if (!['blob', 'arrayBuffer', 'stream'].includes(representation)) {
    throw new SchematicsException(
      'ship-angular:download — representation must be blob, arrayBuffer, or stream.'
    );
  }
  const contractPackage = moduleSpecifier(
    options.contractPackage ?? '@my-org/ship-api-contract',
    'contractPackage',
    'download'
  );
  const contractType = typescriptIdentifier(
    options.contractType ?? 'AppContract',
    'contractType',
    'download'
  );
  const bindingPackage = moduleSpecifier(
    options.bindingPackage ?? '@my-org/ship-api-client',
    'bindingPackage',
    'download'
  );
  const bindingName = typescriptIdentifier(
    options.bindingName ?? `${strings.camelize(name)}DownloadBinding`,
    'bindingName',
    'download'
  );
  const apiImport = moduleSpecifier(options.apiImport ?? '../../api', 'apiImport', 'download');

  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.download.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:download — ${target} already exists. Choose a different name.`
        );
      }
      const source = apply(url('./files'), [
        renderTemplates({
          ...strings,
          name: className,
          fileName,
          operationId,
          representation,
          contractPackage,
          contractType,
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
        `✓ ship-angular:download — created ${targetDir}/${fileName}.download.ts for operation ${operationId}.`
      );
    },
  ]);
}
