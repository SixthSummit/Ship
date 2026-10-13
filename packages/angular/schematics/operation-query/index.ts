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
import { pinQueryDependency } from './pin-query-dependency';

export interface OperationQueryOptions {
  name: string;
  operationId: string;
  contractPackage: string;
  contractType: string;
  clientTokenImport: string;
  clientToken: string;
  /** Import a token that provides ShipQueryContext, including its application-owned scope. */
  scopeSourceImport: string;
  scopeSource: string;
  keyMapperImport: string;
  keyMapper: string;
  variantKeyImport: string;
  variantKey: string;
  safety: 'safe';
  path?: string;
  setupQuery?: boolean;
}

/** Scaffold an application-declared safe read. Query setup is a separate explicit opt-in. */
export function operationQuery(options: OperationQueryOptions): Rule {
  const required = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new SchematicsException(`ship-angular:operation-query — ${name} is required.`);
    }
    return value;
  };
  const identifier = (value: unknown, name: string) =>
    typescriptIdentifier(required(value, name), name, 'operation-query');
  const moduleImport = (value: unknown, name: string) => {
    const specifier = moduleSpecifier(required(value, name), name, 'operation-query');
    const valid = specifier.startsWith('.')
      ? /^(?:\.\.?\/)+(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(specifier)
      : /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/.test(
          specifier
        );
    if (!valid) {
      throw new SchematicsException(
        `ship-angular:operation-query — ${name} must be a static module import.`
      );
    }
    return specifier;
  };
  const name = schematicName(required(options?.name, 'name'), 'operation-query');
  if (options.safety !== 'safe') {
    throw new SchematicsException('ship-angular:operation-query — safety must explicitly be safe.');
  }
  if (options.setupQuery !== undefined && typeof options.setupQuery !== 'boolean') {
    throw new SchematicsException('ship-angular:operation-query — setupQuery must be boolean.');
  }
  const targetDir = destinationPath(options.path ?? 'src/app/queries', 'path', 'operation-query');
  const fileName = strings.dasherize(name);
  const values = {
    ...strings,
    name: strings.classify(name),
    fileName,
    operationId: stableOperationId(
      required(options.operationId, 'operationId'),
      'operationId',
      'operation-query'
    ),
    contractPackage: moduleImport(options.contractPackage, 'contractPackage'),
    contractType: identifier(options.contractType, 'contractType'),
    clientTokenImport: moduleImport(options.clientTokenImport, 'clientTokenImport'),
    clientToken: identifier(options.clientToken, 'clientToken'),
    scopeSourceImport: moduleImport(options.scopeSourceImport, 'scopeSourceImport'),
    scopeSource: identifier(options.scopeSource, 'scopeSource'),
    keyMapperImport: moduleImport(options.keyMapperImport, 'keyMapperImport'),
    keyMapper: identifier(options.keyMapper, 'keyMapper'),
    variantKeyImport: moduleImport(options.variantKeyImport, 'variantKeyImport'),
    variantKey: identifier(options.variantKey, 'variantKey'),
  };
  return chain([
    (tree: Tree, context: SchematicContext) => {
      const target = `${targetDir}/${fileName}.query.ts`;
      if (tree.exists(`/${target}`)) {
        throw new SchematicsException(
          `ship-angular:operation-query — ${target} already exists. Choose a different name.`
        );
      }
      // Validate setup before changing any files. Dependency installation remains caller-owned.
      const packageJson = options.setupQuery === true ? pinQueryDependency(tree) : undefined;
      const source = apply(url('./files'), [renderTemplates(values), move(targetDir)]);
      return chain([
        mergeWith(source),
        (updated: Tree) => {
          if (packageJson !== undefined) updated.overwrite('/package.json', packageJson);
        },
      ])(tree, context);
    },
    (_tree: Tree, context: SchematicContext) => {
      context.logger.info(
        `✓ ship-angular:operation-query — created ${targetDir}/${fileName}.query.ts for ${values.operationId}.`
      );
      context.logger.info(
        options.setupQuery === true
          ? 'TanStack Query is pinned to 5.104.1. Run your package manager install command.'
          : 'Query setup is opt-in. Use setupQuery=true to pin @tanstack/angular-query-experimental@5.104.1.'
      );
      context.logger.info(
        'Provide the configured scope source as ShipQueryContext. Register provideShipQuery with application-owned namespace and scopeKey.'
      );
    },
  ]);
}
