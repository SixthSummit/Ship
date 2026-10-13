/**
 * `ng generate @sixthsummit/ship-angular:api-client` schematic.
 *
 * Scaffolds an application-typed operation-client token and request-scoped
 * Angular provider at `src/api.ts`. The consumer supplies the packed ShipAPI
 * client's structural factory; this schematic never imports a server app or Hono.
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
import { destinationPath, moduleSpecifier, typescriptIdentifier } from '../utils/validate-options';

interface ApiClientOptions {
  contractPackage?: string;
  contractType?: string;
  baseUrlImport?: string;
  baseUrlExpression?: string;
  cookieNames?: string[];
  headerNames?: string[];
  path?: string;
}

export function apiClient(options: ApiClientOptions): Rule {
  const contractPackage = moduleSpecifier(
    options.contractPackage ?? '@my-org/ship-api-contract',
    'contractPackage',
    'api-client'
  );
  const contractType = typescriptIdentifier(
    options.contractType ?? 'AppContract',
    'contractType',
    'api-client'
  );
  const baseUrlImport =
    options.baseUrlImport ?? "import { environment } from './environments/environment';";
  const baseUrlExpression = options.baseUrlExpression ?? 'environment.apiBaseUrl';
  const cookieNames = JSON.stringify(options.cookieNames ?? []);
  const headerNames = JSON.stringify(options.headerNames ?? ['x-request-id', 'accept-language']);
  const targetDir = destinationPath(options.path ?? 'src', 'path', 'api-client');

  return chain([
    (tree: Tree, _ctx: SchematicContext) => {
      const target = `${targetDir}/api.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:api-client — ${target} already exists. Remove it first or pass --path.`
        );
      }
      const templateSource = apply(url('./files'), [
        renderTemplates({
          ...strings,
          contractPackage,
          contractType,
          baseUrlImport,
          baseUrlExpression,
          cookieNames,
          headerNames,
        }),
        move(targetDir),
      ]);
      return mergeWith(templateSource)(tree, _ctx);
    },
    (_tree: Tree, ctx: SchematicContext) => {
      ctx.logger.info(
        `✓ ship-angular:api-client — created ${targetDir}/api.ts. Point \`${contractPackage}\` at the packed package exporting \`type ${contractType}\`.`
      );
      ctx.logger.info(
        '  Register `provideAppShipClient(context => ({ client, requestPolicy }))` in app.config.ts; both are browser/SSR request scoped.'
      );
    },
  ]);
}
