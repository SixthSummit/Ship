#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { createBrowserFixtureServer } from '../conformance/browser/fixture-server.mjs';
import { createRealtimeFixtureServer } from '../conformance/browser/realtime-fixture-server.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const coreRoot = path.join(repositoryRoot, '..', 'packages', 'angular');
const sourceRoot = path.join(repositoryRoot, 'conformance', 'browser');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ship-angular-browser-'));

let fixture;
let realtimeFixture;
let redirectDestination;
let vite;
let browser;

try {
  await assertBuildExists();
  await preparePackedApplication();
  assertPackedRuntimeImports();

  fixture = await createBrowserFixtureServer();
  realtimeFixture = await createRealtimeFixtureServer();
  redirectDestination = await createBrowserFixtureServer();
  fixture.setRedirectOrigin(redirectDestination.origin);
  vite = await createViteServer({
    root: temporaryRoot,
    configFile: false,
    logLevel: 'error',
    define: {
      __SHIP_FIXTURE_ORIGIN__: JSON.stringify(fixture.origin),
      __SHIP_FIXTURE_WS_ORIGIN__: JSON.stringify(fixture.wsOrigin),
      __SHIP_REALTIME_ORIGIN__: JSON.stringify(realtimeFixture.origin),
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
  });
  await vite.listen();
  const viteAddress = vite.httpServer?.address();
  if (viteAddress === null || viteAddress === undefined || typeof viteAddress === 'string') {
    throw new Error('Browser conformance Vite server has no TCP port');
  }
  const applicationOrigin = `http://127.0.0.1:${viteAddress.port}`;
  fixture.setAllowedOrigin(applicationOrigin);
  realtimeFixture.setAllowedOrigin(applicationOrigin);
  redirectDestination.setAllowedOrigin(applicationOrigin);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', message => {
    if (
      message.type() === 'error' &&
      !isExpectedHttpStatusConsoleMessage(message.text()) &&
      // Chromium omits the URL for blocked redirects; requestfailed below checks it.
      message.text() !== 'Failed to load resource: net::ERR_FAILED' &&
      !message.location().url.endsWith('/download/redirect')
    ) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', error => consoleErrors.push(`${error.name}: ${error.message}`));
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText ?? 'unknown';
    if (reason === 'net::ERR_FAILED' && request.url().endsWith('/download/redirect')) return;
    if (
      reason === 'net::ERR_ABORTED' &&
      (/\/(?:upload|download|stream)\/slow$/.test(request.url()) ||
        request.url().includes('/wire-stream'))
    ) {
      return;
    }
    // Socket.IO tears its long-poll and upgrade requests down when the client closes.
    if (request.url().includes('/socket.io/')) return;
    consoleErrors.push(`Request failed: ${request.url()} (${reason})`);
  });
  await page.goto(applicationOrigin, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => globalThis.__SHIP_BROWSER_DONE__ === true, undefined, {
      timeout: 20_000,
    });
  } catch (error) {
    const status = await page
      .locator('#status')
      .textContent()
      .catch(() => undefined);
    throw new Error(
      `Browser capability suite timed out (status=${String(status)}): ${consoleErrors.join(' | ')}`,
      { cause: error }
    );
  }
  const outcome = await page.evaluate(() => ({
    error: globalThis.__SHIP_BROWSER_ERROR__,
    report: globalThis.__SHIP_BROWSER_REPORT__,
  }));
  if (outcome.error !== undefined) {
    throw new Error(
      `Browser capability suite failed: ${outcome.error.name}: ${outcome.error.message}`
    );
  }
  if (outcome.report === undefined) {
    throw new Error('Browser capability suite completed without a report');
  }
  assertReport(outcome.report, applicationOrigin);
  assertRealtime(outcome.report, realtimeFixture.snapshot(), applicationOrigin);
  assert(
    redirectDestination.snapshot().requests.length === 0,
    'A redirect reached an unapproved origin'
  );
  assert(
    fixture
      .snapshot()
      .requests.some(
        request =>
          request.path === '/download/redirect' &&
          request.customCredential === 'Bearer browser-secret'
      ),
    'Redirect test did not send the custom credential to the approved origin'
  );
  if (consoleErrors.length > 0) {
    throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`);
  }

  console.log('\nBrowser conformance passed');
  console.log(JSON.stringify(outcome.report, null, 2));
} finally {
  await browser?.close();
  await vite?.close();
  await fixture?.close();
  await realtimeFixture?.close();
  await redirectDestination?.close();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

async function assertBuildExists() {
  const entry = path.join(coreRoot, 'lib', 'fesm2022', 'sixthsummit-ship-angular-operations.mjs');
  try {
    await fs.access(entry);
  } catch {
    throw new Error('Browser conformance requires a fresh core build. Run `pnpm build` first.');
  }
}

async function preparePackedApplication() {
  const tarball = path.join(temporaryRoot, 'ship-angular.tgz');
  execFileSync('pnpm', ['pack', '--out', tarball], {
    cwd: coreRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const extraction = path.join(temporaryRoot, 'extraction');
  await fs.mkdir(extraction, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', extraction]);
  const packageTarget = path.join(temporaryRoot, 'node_modules', '@sixthsummit', 'ship-angular');
  await fs.mkdir(path.dirname(packageTarget), { recursive: true });
  await fs.rename(path.join(extraction, 'package'), packageTarget);
  await fs.cp(path.join(sourceRoot, 'app'), temporaryRoot, { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, 'tsconfig.json'),
    path.join(temporaryRoot, 'tsconfig.json')
  );

  for (const dependency of [
    '@angular/common',
    '@angular/compiler',
    '@angular/core',
    'rxjs',
    'socket.io-client',
    'tslib',
  ]) {
    await linkDependency(dependency);
  }

  const typescript = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [typescript, '-p', path.join(temporaryRoot, 'tsconfig.json')], {
    cwd: temporaryRoot,
    stdio: 'inherit',
  });
}

async function linkDependency(specifier) {
  const source = path.join(coreRoot, 'node_modules', ...specifier.split('/'));
  const target = path.join(temporaryRoot, 'node_modules', ...specifier.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(await fs.realpath(source), target, 'junction');
}

function assertPackedRuntimeImports() {
  for (const entrypoint of ['operations', 'upload', 'download', 'stream', 'socket', 'realtime']) {
    const expected = path.join(
      temporaryRoot,
      'node_modules',
      '@sixthsummit',
      'ship-angular',
      'lib',
      'fesm2022',
      `sixthsummit-ship-angular-${entrypoint}.mjs`
    );
    execFileSync(
      process.execPath,
      [
        '-e',
        `import('@angular/compiler').then(() => import(${JSON.stringify(pathToFileURL(expected).href)}))`,
      ],
      {
        cwd: temporaryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  }
}

function assertReport(report, applicationOrigin) {
  assert(report.cookieEstablished === true, 'cookie setup was not reported');
  assert(report.upload.status === 'complete', 'upload did not complete');
  assert(
    report.upload.observedProgress > 0 && report.upload.observedProgress <= 1,
    'real XHR progress was not reflected in browser state'
  );
  assert(report.upload.requestId === 'browser-upload-request', 'upload request ID was not exposed');
  assert(report.upload.failureCode === 'UPLOAD_REJECTED', 'upload error envelope was lost');
  assert(
    report.upload.cancellation === 'OperationAbortedError',
    'upload cancellation was not normalized'
  );

  assertArray(report.download.bytes, [0, 1, 2, 3, 4, 255], 'download bytes');
  assert(report.download.filename === 'browser-proof.pdf', 'download filename was not retained');
  assert(
    report.download.requestId === 'browser-download-request',
    'download request ID was not exposed'
  );
  assert(report.download.etag === 'browser-download-v1', 'download ETag was not exposed');
  assert(
    report.download.failureCode === 'REPORT_NOT_FOUND',
    'download JSON error was treated as bytes'
  );
  assert(
    report.download.cancellation === 'OperationAbortedError',
    'download cancellation was not normalized'
  );

  assertArray(report.stream.values, [1, 2], 'stream event values');
  assert(report.stream.lastEventId === 'event-2', 'stream event ID was not retained');
  assert(report.stream.requestId === 'browser-stream-request', 'stream request ID was not exposed');
  assert(
    report.stream.cancellation === 'OperationAbortedError',
    'stream cancellation was not normalized'
  );

  assertArray(report.wireStream.deltas, ['he', 'llo'], 'wire stream frames');
  assert(report.wireStream.terminalTokens === 42, 'wire stream terminal payload was lost');
  assert(report.wireStream.seq === 3, 'wire stream id sequence was not tracked');
  assertArray(
    report.wireStream.statusTransitions,
    ['connecting', 'open', 'closed'],
    'wire stream status transitions'
  );
  assert(
    report.wireStream.errorAfterFrame.code === 'STREAM_MAX_FRAMES_EXCEEDED' &&
      report.wireStream.errorAfterFrame.status === 500,
    'wire stream error event was not surfaced with its stable code'
  );
  assertArray(
    report.wireStream.errorAfterFrameDeltas,
    ['he'],
    'frames received before a wire error event'
  );
  assert(
    report.wireStream.errorBeforeFrame.code === 'AGENT_NOT_FOUND' &&
      report.wireStream.errorBeforeFrame.status === 404,
    'pre-first-frame JSON error envelope was not surfaced as a client error'
  );
  assert(
    report.wireStream.errorBeforeFrameStatus === 'error',
    'pre-first-frame failure did not end the stream in error'
  );
  assert(report.wireStream.abortStatus === 'aborted', 'wire stream abort was not normalized');
  assert(
    report.wireStream.terminalOnlyFrames === 0 && report.wireStream.terminalOnlyStatus === 'closed',
    'a terminal-only stream did not close cleanly with no frames'
  );
  assert(
    report.wireStream.terminalOnlyTerminal === 'undefined',
    'a null terminal payload was not decoded as undefined'
  );
  assert(report.metrics.wireStreamAborted === true, 'server did not observe the wire stream abort');

  assert(report.socket.ticketCalls === 2, 'socket reconnect did not acquire a fresh ticket');
  assert(report.socket.status === 'closed', 'socket did not close cleanly');
  assert(report.socket.sendQueued === false, 'an open socket send was unexpectedly queued');
  assert(
    report.socket.messages.some(value => value.startsWith('echo:')),
    'socket echo was not contract-decoded'
  );

  assert(report.metrics.uploadAborted === true, 'server did not observe upload abort');
  assert(report.metrics.slowDownloadClosed === true, 'server did not observe download abort');
  assert(report.metrics.slowStreamClosed === true, 'server did not observe stream abort');
  const uploadRequest = findRequest(report.metrics.requests, '/upload');
  assert(
    uploadRequest.origin === applicationOrigin,
    'upload Origin was not cross-origin fixture app'
  );
  assert(uploadRequest.cookie === 'browser-session=alpha', 'cookie credential was not applied');
  assert(uploadRequest.authorization === undefined, 'a bearer credential leaked into cookie mode');
  assert(uploadRequest.csrf === 'browser-csrf', 'CSRF header was not applied');
  assert(
    uploadRequest.requestId?.startsWith('browser-request-'),
    'request ID policy was not applied'
  );
  assert(uploadRequest.idempotencyKey === 'browser-upload-key', 'idempotency key was not applied');
  assert(
    uploadRequest.contentType?.startsWith('multipart/form-data; boundary='),
    'browser did not construct a multipart upload boundary'
  );
  for (const request of report.metrics.requests.filter(
    item => item.path !== '/session/set' && item.path !== '/download/redirect'
  )) {
    assert(request.origin === applicationOrigin, `${request.path} used the wrong browser origin`);
    assert(
      request.cookie === 'browser-session=alpha',
      `${request.path} omitted the session cookie`
    );
    assert(request.authorization === undefined, `${request.path} leaked a bearer credential`);
    assert(
      request.requestId?.startsWith('browser-request-'),
      `${request.path} omitted its policy request ID`
    );
    if (!request.path.startsWith('/upload')) {
      assert(request.csrf === undefined, `${request.path} received an unnecessary CSRF token`);
      assert(
        request.idempotencyKey === undefined,
        `${request.path} received an unnecessary idempotency key`
      );
    }
  }
  assert(report.metrics.socketConnections.length === 2, 'socket did not reconnect exactly once');
  assertArray(
    report.metrics.socketConnections.map(connection => connection.ticket),
    ['browser-ticket-1', 'browser-ticket-2'],
    'socket tickets'
  );
  for (const connection of report.metrics.socketConnections) {
    assert(connection.origin === applicationOrigin, 'socket Origin did not match the fixture app');
    assert(connection.protocol === 'ship.v1', 'socket protocol negotiation drifted');
  }
  assert(
    report.metrics.socketMessages.includes('{"action":"ping"}'),
    'socket server did not receive the encoded client message'
  );
}

function assertRealtime(report, metrics, applicationOrigin) {
  const realtime = report.realtime;
  assert(realtime !== undefined, 'realtime capability was not reported');
  assert(realtime.status === 'active', 'the declared subscription never became active');
  assert(
    realtime.payload?.text === 'hello from room.messages',
    'the typed realtime payload was not delivered'
  );
  assert(realtime.seq === 1, 'the realtime sequence number was not exposed');
  assert(realtime.presenceCount === 2, 'presence membership was not tracked');
  assert(
    realtime.presenceMembers.includes('actor-conformance') &&
      realtime.presenceMembers.includes('actor-observer'),
    'the presence snapshot and the joined frame were not merged'
  );
  assert(realtime.dropped === 3, 'the dropped counter did not reflect the drop batch');
  assert(realtime.forbiddenStatus === 'forbidden', 'a forbidden subscription was not refused');
  assert(
    realtime.forbiddenCode === 'SUBSCRIPTION_FORBIDDEN',
    'the forbidden ack code was not surfaced'
  );
  assert(realtime.invalidScopeCode === 'INVALID_SCOPE', 'the scope check was not enforced');
  assert(realtime.ssrStatus === 'closed', 'an SSR subscription was not returned closed');

  assert(metrics.connections.length === 1, 'the realtime client did not open exactly one socket');
  const connection = metrics.connections[0];
  assert(connection.origin === applicationOrigin, 'the realtime socket used the wrong origin');
  assert(
    connection.credential === 'browser-realtime-token-1',
    'the credential provider was not used for the handshake'
  );
  assert(
    metrics.presenceSnapshots.some(request => request.channel === 'room.messages'),
    'no presence snapshot was requested for the presence channel'
  );
  assert(
    metrics.unsubscribes.length === 1,
    'the client did not tell the gateway about its unsubscribe'
  );
}

function findRequest(requests, pathName) {
  const request = requests.find(candidate => candidate.path === pathName);
  if (request === undefined) throw new Error(`Fixture did not receive ${pathName}`);
  return request;
}

function assertArray(received, expected, label) {
  if (!Array.isArray(received) || JSON.stringify(received) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(received)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isExpectedHttpStatusConsoleMessage(message) {
  return /Failed to load resource: the server responded with a status of (?:404|422)/.test(message);
}
