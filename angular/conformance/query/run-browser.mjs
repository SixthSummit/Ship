#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPhysicalPackage } from './archive-consumer.mjs';
import { createCandidateWireServer } from './candidate-wire-server.mjs';

const [consumer] = process.argv.slice(2);
if (!consumer)
  throw new Error('Usage: node conformance/query/run-browser.mjs <installed-archive-consumer>');
const root = path.resolve(consumer);
const version = await assertPhysicalPackage(root);
const consumerRequire = createRequire(path.join(root, 'package.json'));
const { chromium } = consumerRequire('playwright');
const { createServer } = await import(pathToFileURL(consumerRequire.resolve('vite')).href);
await writeFile(
  path.join(root, 'index.html'),
  '<!doctype html><html><body><script type="module" src="/browser-entry.mjs"></script></body></html>'
);
await writeFile(
  path.join(root, 'browser-entry.mjs'),
  `
import '@angular/compiler';
import { enableProdMode } from '@angular/core';
import { createBrowserAdapter } from './candidate-browser.mjs';
import { queryScenarios, runQueryConformance } from './scenarios.mjs';
import { runCandidateWire } from './candidate-wire.mjs';
enableProdMode();
try {
  const only = Object.keys(queryScenarios).filter(name => name !== 'ssr');
  globalThis.queryReport = await runQueryConformance(createBrowserAdapter, { only });
  globalThis.wireReport = await runCandidateWire(createBrowserAdapter, globalThis.queryWireControl, globalThis.queryWireOrigin);
} catch (error) { globalThis.queryFailure = { message: error.message, stack: error.stack }; }
finally { globalThis.queryDone = true; }
`
);
const wire = await createCandidateWireServer();
let server;
let browser;
try {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, fs: { strict: true, allow: [root] } },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.exposeFunction('queryWireControl', wire.control);
  await page.addInitScript(origin => {
    globalThis.queryWireOrigin = origin;
  }, wire.origin);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.waitForFunction(() => globalThis.queryDone === true, undefined, { timeout: 30000 });
  const result = await page.evaluate(() => ({
    report: globalThis.queryReport,
    wire: globalThis.wireReport,
    failure: globalThis.queryFailure,
  }));
  if (result.failure || errors.length) throw new Error(JSON.stringify({ ...result, errors }));
  if (result.report.passed.length !== 9 || result.report.skipped.join() !== 'ssr')
    throw new Error('Browser scenario inventory is incomplete');
  console.log(
    JSON.stringify({
      kind: 'physical-chromium',
      version,
      consumer: root,
      passed: result.report.passed,
      requiredSkips: [],
      separateServerGate: 'ssr',
      sourceAliases: false,
      wire: result.wire,
    })
  );
} finally {
  await wire.close();
  await browser?.close();
  await server?.close();
}
