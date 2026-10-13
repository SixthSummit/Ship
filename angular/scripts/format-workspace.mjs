import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Biome and Prettier are invoked by absolute binary paths below; knip lists them explicitly.
const mode = process.argv[2];
const write = process.argv.includes('--write');
for (const directory of ['angular', 'packages/angular', 'apps/angular-docs']) {
  const args =
    mode === 'imports'
      ? ['check', '--formatter-enabled=false', '--linter-enabled=false']
      : ['format'];
  if (write) args.push('--write');
  args.push('.');
  run('biome', args, directory);
  if (mode !== 'imports') {
    run(
      'prettier',
      [write ? '--write' : '--check', '**/*.{md,yml,yaml,astro,html,scss}'],
      directory
    );
  }
}
function run(tool, args, directory) {
  const result = spawnSync(path.join(root, 'angular/node_modules/.bin', tool), args, {
    cwd: path.join(root, directory),
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
