import { SchematicsException, type Tree } from '@angular-devkit/schematics';

const PACKAGE = '@tanstack/angular-query-experimental';
const VERSION = '5.104.1';

/** Prepare the explicitly requested application dependency pin without changing the tree. */
export function pinQueryDependency(tree: Tree): string {
  const source = tree.read('/package.json');
  if (source === null) {
    throw new SchematicsException(
      'ship-angular:operation-query — setupQuery requires package.json.'
    );
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(source.toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('object required');
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new SchematicsException(
      'ship-angular:operation-query — package.json must contain a JSON object.'
    );
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const section = manifest[field];
    if (section === undefined) continue;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new SchematicsException(
        `ship-angular:operation-query — ${field} must contain a dependency object.`
      );
    }
    const existing = (section as Record<string, unknown>)[PACKAGE];
    if (existing !== undefined && existing !== VERSION) {
      throw new SchematicsException(
        `ship-angular:operation-query — ${PACKAGE} is ${String(existing)} in ${field}. Use the exact supported version ${VERSION} before setup.`
      );
    }
  }
  return `${JSON.stringify({ ...manifest, dependencies: { ...(manifest.dependencies as object | undefined), [PACKAGE]: VERSION } }, null, 2)}\n`;
}
