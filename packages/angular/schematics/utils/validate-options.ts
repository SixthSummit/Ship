import { SchematicsException } from '@angular-devkit/schematics';

export function schematicName(value: string, schematic: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(normalized)) {
    throw invalid(
      schematic,
      'name',
      'a letter-led name containing letters, numbers, spaces, _ or -'
    );
  }
  return normalized;
}

export function stableOperationId(value: string, option: string, schematic: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(normalized)) {
    throw invalid(schematic, option, 'a stable operation ID');
  }
  return normalized;
}

export function optionalStableOperationId(
  value: string | undefined,
  option: string,
  schematic: string
): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return stableOperationId(value, option, schematic);
}

export function typescriptIdentifier(value: string, option: string, schematic: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) {
    throw invalid(schematic, option, 'a TypeScript identifier');
  }
  return normalized;
}

export function moduleSpecifier(value: string, option: string, schematic: string): string {
  const normalized = value.trim();
  if (!/^(?:\.{1,2}\/|@?[A-Za-z0-9])[A-Za-z0-9@._/-]*$/.test(normalized)) {
    throw invalid(schematic, option, 'a static package or relative module specifier');
  }
  return normalized;
}

export function destinationPath(value: string, option: string, schematic: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (
    normalized === '' ||
    segments.some(
      segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/.test(segment)
    )
  ) {
    throw invalid(schematic, option, 'a project-relative destination without . or .. segments');
  }
  return normalized;
}

function invalid(schematic: string, option: string, expected: string): SchematicsException {
  return new SchematicsException(`ship-angular:${schematic} — ${option} must be ${expected}.`);
}
