import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const coreRoot = path.join(__dirname, '..', '..', 'packages', 'angular');

async function verifyNgPackagrOutput() {
  // Verify ng-packagr created the expected output structure
  const libPackageJsonPath = path.join(coreRoot, 'lib', 'package.json');

  try {
    await fs.access(libPackageJsonPath);
    console.log('✓ ng-packagr output verified (lib/package.json exists)');
  } catch {
    console.error('❌ ng-packagr output not found - build may have failed');
    throw new Error('ng-packagr output missing');
  }
}

async function ensureSchematicsCjsMarker() {
  // The schematics compile to CommonJS (tsconfig.schematics.json), but the
  // package is `"type": "module"`. @angular-devkit/schematics resolves every
  // factory via plain `require(module)[exportName]` (tools/export-ref.js), so
  // the schematics/ subtree must opt back into CommonJS via a nested
  // package.json — otherwise every `ng add` / `ng generate` factory resolves
  // to `undefined`. The marker is committed; this guard recreates it if lost.
  const markerPath = path.join(coreRoot, 'schematics', 'package.json');

  try {
    const existing = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (existing.type === 'commonjs') {
      console.log('✓ schematics/package.json CommonJS marker present');
      return;
    }
  } catch {
    // Missing or unparsable — rewrite below.
  }

  await fs.writeFile(markerPath, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
  console.log('✓ Restored schematics/package.json CommonJS marker');
}

async function buildCore() {
  console.log('Post-build tasks for @sixthsummit/ship-angular...\n');

  try {
    // Verify ng-packagr created proper output
    await verifyNgPackagrOutput();

    // Keep the schematics loadable from the "type":"module" package
    await ensureSchematicsCjsMarker();

    console.log('\n✓ Core package build complete!');
  } catch (error) {
    console.error('Build failed:', error.message);
    process.exit(1);
  }
}

buildCore().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
