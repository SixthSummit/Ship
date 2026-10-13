/**
 * `ng generate @sixthsummit/ship-angular:operation-auth <name>` schematic.
 *
 * Scaffolds an explicit cookie-session adapter factory over generated operation
 * IDs. Identity decoding remains a required application input because the
 * framework cannot safely infer an application's user projection.
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
  optionalStableOperationId,
  schematicName,
  stableOperationId,
  typescriptIdentifier,
} from '../utils/validate-options';

interface OperationAuthOptions {
  name: string;
  meOperationId?: string;
  signInOperationId?: string;
  registerOperationId?: string;
  signOutOperationId?: string;
  refreshOperationId?: string;
  contractPackage?: string;
  contractType?: string;
  apiImport?: string;
  path?: string;
}

export function operationAuth(options: OperationAuthOptions): Rule {
  if (!options.name) {
    throw new SchematicsException('ship-angular:operation-auth — name is required.');
  }
  const name = schematicName(options.name, 'operation-auth');
  const targetDir = destinationPath(options.path ?? 'src/auth', 'path', 'operation-auth');
  const className = strings.classify(name);
  const fileName = strings.dasherize(name);
  const meOperationId = stableOperationId(
    options.meOperationId ?? 'auth.me',
    'meOperationId',
    'operation-auth'
  );
  const signInOperationId = optionalStableOperationId(
    options.signInOperationId ?? 'auth.login',
    'signInOperationId',
    'operation-auth'
  );
  const registerOperationId = optionalStableOperationId(
    options.registerOperationId,
    'registerOperationId',
    'operation-auth'
  );
  const signOutOperationId = optionalStableOperationId(
    options.signOutOperationId ?? 'auth.logout',
    'signOutOperationId',
    'operation-auth'
  );
  const refreshOperationId = optionalStableOperationId(
    options.refreshOperationId ?? 'auth.refresh',
    'refreshOperationId',
    'operation-auth'
  );
  const contractPackage = moduleSpecifier(
    options.contractPackage ?? '@my-org/ship-api-contract',
    'contractPackage',
    'operation-auth'
  );
  const contractType = typescriptIdentifier(
    options.contractType ?? 'AppContract',
    'contractType',
    'operation-auth'
  );
  const apiImport = moduleSpecifier(options.apiImport ?? '../api', 'apiImport', 'operation-auth');

  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.session-auth.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:operation-auth — ${target} already exists. Choose a different name.`
        );
      }
      const source = apply(url('./files'), [
        renderTemplates({
          ...strings,
          name: className,
          fileName,
          meOperationId,
          signInOperationId,
          registerOperationId,
          signOutOperationId,
          refreshOperationId,
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
        `✓ ship-angular:operation-auth — created ${targetDir}/${fileName}.session-auth.ts with explicit operation bindings.`
      );
      context.logger.info(
        '  Supply a validated mapUser function when creating the adapter; generated code does not cast server data into AuthUser.'
      );
    },
  ]);
}
