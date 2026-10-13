import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ngPackagr } from 'ng-packagr';

const core = path.dirname(fileURLToPath(import.meta.url));
const staging = await mkdtemp(path.join(os.tmpdir(), 'ship-angular-package-input-'));
try {
  const manifest = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'));
  // The source manifest serves the repository's packed lib/ layout. ng-packagr
  // owns the root and secondary APF mappings in its separate lib/package.json.
  // Retain hand-owned exports; omit only mappings this build actually generates.
  const entries = [];
  for (const directory of await readdir(core, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    try {
      const config = JSON.parse(
        await readFile(path.join(core, directory.name, 'ng-package.json'), 'utf8')
      );
      entries.push({ name: directory.name, config });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const name of ['.', './package.json', ...entries.map(entry => `./${entry.name}`)]) {
    delete manifest.exports[name];
  }
  await writeFile(path.join(staging, 'package.json'), JSON.stringify(manifest));
  const config = JSON.parse(await readFile(path.join(core, 'ng-package.json'), 'utf8'));
  config.dest = path.relative(staging, path.join(core, 'lib'));
  await writeFile(path.join(staging, 'ng-package.json'), JSON.stringify(config));
  await symlink(path.join(core, 'src'), path.join(staging, 'src'), 'dir');
  await symlink(path.join(core, 'node_modules'), path.join(staging, 'node_modules'), 'dir');
  for (const { name, config: entryConfig } of entries) {
    const entry = path.join(staging, name);
    await mkdir(entry);
    await writeFile(path.join(entry, 'ng-package.json'), JSON.stringify(entryConfig));
    await symlink(path.join(core, name, 'src'), path.join(entry, 'src'), 'dir');
  }
  await ngPackagr()
    .forProject(path.join(staging, 'ng-package.json'))
    .withTsConfig(path.join(core, 'tsconfig.lib.json'))
    .build();
  await normalizeSourceMaps(path.join(core, 'lib'));
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function normalizeSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeSourceMaps(file);
    } else if (entry.name.endsWith('.map')) {
      const map = JSON.parse(await readFile(file, 'utf8'));
      map.sources = map.sources.map(source => {
        const absolute = path.resolve(path.dirname(file), map.sourceRoot ?? '', source);
        const relative = path.relative(staging, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return source;
        return path
          .relative(path.dirname(file), path.join(core, relative))
          .split(path.sep)
          .join('/');
      });
      await writeFile(file, JSON.stringify(map));
    }
  }
}
