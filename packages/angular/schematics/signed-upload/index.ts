/** Generate an injectable factory over a generated signed-upload binding. */
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

interface SignedUploadOptions {
  name: string;
  bindingPackage?: string;
  bindingName?: string;
  apiImport?: string;
  path?: string;
}

export function signedUpload(options: SignedUploadOptions): Rule {
  if (!options.name) {
    throw new SchematicsException('ship-angular:signed-upload — name is required.');
  }
  const name = schematicName(options.name, 'signed-upload');
  const targetDir = destinationPath(options.path ?? 'src/app/services', 'path', 'signed-upload');
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const bindingPackage = moduleSpecifier(
    options.bindingPackage ?? '@my-org/ship-api-client',
    'bindingPackage',
    'signed-upload'
  );
  const bindingName = typescriptIdentifier(
    options.bindingName ?? `${strings.camelize(name)}SignedUploadBinding`,
    'bindingName',
    'signed-upload'
  );
  const apiImport = moduleSpecifier(options.apiImport ?? '../../api', 'apiImport', 'signed-upload');

  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.signed-upload.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:signed-upload — ${target} already exists. Choose a different name.`
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
        `✓ ship-angular:signed-upload — created ${targetDir}/${fileName}.signed-upload.ts. Pass exact provider origins when creating an upload.`
      );
    },
  ]);
}
