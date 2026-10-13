/**
 * `ng generate @sixthsummit/ship-angular:upload <name>` schematic.
 *
 * Scaffolds a standalone, OnPush upload component over a generated operation
 * binding. Shared policy supplies auth/CSRF/request metadata to its XHR adapter.
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

interface UploadOptions {
  name: string;
  operationId?: string;
  fieldName?: string;
  contractPackage?: string;
  contractType?: string;
  bindingPackage?: string;
  bindingName?: string;
  apiImport?: string;
  path?: string;
}

export function upload(options: UploadOptions): Rule {
  if (!options.name) throw new SchematicsException('ship-angular:upload — name is required.');
  const name = schematicName(options.name, 'upload');
  const targetDir = destinationPath(options.path ?? 'src/app/components', 'path', 'upload');
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const selector = `app-${fileName}`;
  const operationId = stableOperationId(
    options.operationId ?? 'assets.upload',
    'operationId',
    'upload'
  );
  const fieldName = typescriptIdentifier(options.fieldName ?? 'file', 'fieldName', 'upload');
  const contractPackage = moduleSpecifier(
    options.contractPackage ?? '@my-org/ship-api-contract',
    'contractPackage',
    'upload'
  );
  const contractType = typescriptIdentifier(
    options.contractType ?? 'AppContract',
    'contractType',
    'upload'
  );
  const bindingPackage = moduleSpecifier(
    options.bindingPackage ?? '@my-org/ship-api-client',
    'bindingPackage',
    'upload'
  );
  const bindingName = typescriptIdentifier(
    options.bindingName ?? `${strings.camelize(name)}UploadBinding`,
    'bindingName',
    'upload'
  );
  const apiImport = moduleSpecifier(options.apiImport ?? '../../api', 'apiImport', 'upload');

  return chain([
    (tree: Tree, _ctx: SchematicContext) => {
      const target = `${targetDir}/${fileName}.component.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:upload — ${target} already exists. Choose a different name.`
        );
      }
      const templateSource = apply(url('./files'), [
        renderTemplates({
          ...strings,
          name: className,
          fileName,
          selector,
          operationId,
          fieldName,
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
        `✓ ship-angular:upload — created ${targetDir}/${fileName}.component.ts for operation ${operationId}. Use <${selector}> in your templates.`
      );
    },
  ]);
}
