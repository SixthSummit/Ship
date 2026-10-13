import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  assertPhysicalPackage,
  prepareArchiveConsumer,
  QUERY_TEST_DEPENDENCIES,
} from './archive-consumer.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'query-archive-test-'));
  roots.push(root);
  const archive = path.join(root, 'package.tgz');
  await writeFile(archive, 'fixture preparation only');
  const bridge = path.join(root, 'bridge.mjs');
  await writeFile(bridge, "import { shipQueryOptions } from '@sixthsummit/ship-angular/query';");
  return {
    archive,
    bridge,
    destination: path.join(root, 'consumer'),
    sourceDirectory: path.dirname(fileURLToPath(import.meta.url)),
    install: false,
  };
}
it('prepares one physical archive and exact dependency versions for both runtime and types', async () => {
  const args = await fixture();
  await prepareArchiveConsumer(args);
  const manifest = JSON.parse(await readFile(path.join(args.destination, 'package.json')));
  expect(manifest.dependencies['@sixthsummit/ship-angular']).toBe('file:./ship-angular.tgz');
  expect(manifest.dependencies['@tanstack/angular-query-experimental']).toBe('5.104.1');
  expect(Object.keys(QUERY_TEST_DEPENDENCIES)).toContain('typescript');
  expect(await readFile(path.join(args.destination, 'consumer.type-test.ts'), 'utf8')).toContain(
    '@ts-expect-error'
  );
  const installed = path.join(args.destination, 'node_modules/@sixthsummit/ship-angular');
  await mkdir(installed, { recursive: true });
  await writeFile(
    path.join(installed, 'package.json'),
    JSON.stringify({ version: 'fixture', exports: { './query': './query.mjs' } })
  );
  expect(await assertPhysicalPackage(args.destination)).toBe('fixture');
  await writeFile(path.join(installed, 'package.json'), '{}');
  await expect(assertPhysicalPackage(args.destination)).rejects.toThrow('does not export');
});
it('rejects source links and source-importing bridges before installation', async () => {
  const args = await fixture();
  const link = `${args.archive}.link.tgz`;
  await symlink(args.archive, link);
  await expect(prepareArchiveConsumer({ ...args, archive: link })).rejects.toThrow('physical');
  await writeFile(args.bridge, "import '/source/query.ts'; // @sixthsummit/ship-angular/query");
  await expect(prepareArchiveConsumer(args)).rejects.toThrow('source paths');
  await writeFile(args.bridge, 'export const createQueryAdapter = () => {};');
  await expect(prepareArchiveConsumer(args)).rejects.toThrow('public query');
  const installed = path.join(args.destination, 'node_modules/@sixthsummit');
  await mkdir(installed, { recursive: true });
  await symlink(path.dirname(args.archive), path.join(installed, 'ship-angular'));
  await expect(assertPhysicalPackage(args.destination)).rejects.toThrow('source symlink');
});
