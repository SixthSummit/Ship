import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the schematic loading path.
//
// `@angular-devkit/schematics` resolves every factory with a plain
// `require(module)[exportName]` (tools/export-ref.js) — no ESM fallback.
// This package is `"type": "module"` while the schematics compile to
// CommonJS (tsconfig.schematics.json), so without the nested
// `schematics/package.json` `{ "type": "commonjs" }` marker, Node treats the
// compiled `.js` as ESM and every `ng add` / `ng generate` factory resolves
// to `undefined`.
//
// The compiled `.js` files are build output (`pnpm build:schematics`). Their
// absence is a test failure: required generation must never turn into a silent
// local skip merely because a caller bypassed Turbo's build dependency.

const requireAsDevkitDoes = createRequire(import.meta.url);
const schematicsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'schematics');

interface SchematicEntry {
  factory: string;
}

describe('schematics factory loading', () => {
  it('pins schematics/ back to CommonJS via a nested package.json', () => {
    const markerPath = join(schematicsRoot, 'package.json');
    expect(existsSync(markerPath), `${markerPath} must exist`).toBe(true);
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).type).toBe('commonjs');
  });

  const collection = JSON.parse(readFileSync(join(schematicsRoot, 'collection.json'), 'utf8')) as {
    schematics: Record<string, SchematicEntry>;
  };

  for (const [name, entry] of Object.entries(collection.schematics)) {
    it(`resolves the "${name}" factory the way @angular-devkit does`, () => {
      const [modulePath, exportName] = entry.factory.split('#');
      const compiled = join(schematicsRoot, `${modulePath}.js`);

      expect(existsSync(compiled), `${compiled} must be built before tests run`).toBe(true);

      const factory = requireAsDevkitDoes(compiled)[exportName || 'default'];
      expect(typeof factory, `${entry.factory} must resolve to a function`).toBe('function');
    });
  }
});
