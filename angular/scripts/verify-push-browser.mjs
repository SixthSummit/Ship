import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const angular = path.join(root, 'packages/angular');
const temporary = await mkdtemp(path.join(tmpdir(), 'ship-push-browser-'));
let vite;
let browser;
try {
  const packed = JSON.parse(
    execFileSync('pnpm', ['pack', '--json', '--pack-destination', temporary], {
      cwd: angular,
      encoding: 'utf8',
    })
  );
  execFileSync('tar', ['-xzf', packed.filename, '-C', temporary]);
  const packageRoot = path.join(temporary, 'node_modules/@sixthsummit/ship-angular');
  await mkdir(path.dirname(packageRoot), { recursive: true });
  await rename(path.join(temporary, 'package'), packageRoot);
  for (const name of [
    '@angular/core',
    '@angular/common',
    '@angular/compiler',
    '@angular/platform-browser',
    '@angular/service-worker',
    'rxjs',
    'tslib',
  ]) {
    const target = path.join(temporary, 'node_modules', name);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(await realpath(path.join(angular, 'node_modules', name)), target);
  }
  await cp(
    path.join(root, 'angular/conformance/push-browser/app.ts'),
    path.join(temporary, 'app.ts')
  );
  await writeFile(
    path.join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  await writeFile(
    path.join(temporary, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['app.ts'],
    })
  );
  execFileSync(
    process.execPath,
    [path.join(root, 'angular/node_modules/typescript/bin/tsc'), '-p', temporary],
    { stdio: 'inherit' }
  );
  const html =
    '<!doctype html><title>Ship Web Push conformance</title><script type="module" src="/app.ts"></script>';
  await writeFile(path.join(temporary, 'index.html'), html);
  await cp(
    path.join(angular, 'node_modules/@angular/service-worker/ngsw-worker.js'),
    path.join(temporary, 'ngsw-worker.js')
  );
  await writeFile(
    path.join(temporary, 'ngsw.json'),
    JSON.stringify({
      configVersion: 1,
      timestamp: 1,
      index: '/index.html',
      assetGroups: [],
      dataGroups: [],
      hashTable: { '/index.html': createHash('sha1').update(html).digest('hex') },
      navigationUrls: [],
    })
  );
  vite = await createServer({
    root: temporary,
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: ['notifications'] });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let registration;
  cdp.on('ServiceWorker.workerRegistrationUpdated', event => {
    registration =
      event.registrations.find(value => value.scopeURL === `${origin}/`) ?? registration;
  });
  await cdp.send('ServiceWorker.enable');
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.shipPushBrowser?.ready() === true, undefined, {
    timeout: 20000,
  });
  assert.equal(await page.evaluate(() => globalThis.shipPushBrowser.enabled), true);
  assert.equal(await page.evaluate(() => globalThis.shipPushBrowser.subscribed()), false);
  assert(registration, 'Angular worker registration must exist');
  const worker = context.serviceWorkers().find(value => value.url().endsWith('/ngsw-worker.js'));
  assert(worker, 'Actual Angular service worker must be running');
  // Keep the browser/worker transport real; replace only the OS notification
  // boundary, which is not portable in headless Chromium.
  await worker.evaluate(() => {
    globalThis.shipNotifications = [];
    globalThis.registration.showNotification = async (title, options) => {
      globalThis.shipNotifications.push({ title, options });
    };
  });
  const payload = {
    notification: {
      title: 'Packed push test',
      body: 'Encrypted delivery is tested separately',
      tag: 'ship-push-conformance',
      data: { id: 'synthetic-1' },
    },
  };
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId: registration.registrationId,
    data: JSON.stringify(payload),
  });
  await page.waitForFunction(
    () => globalThis.shipPushBrowser.latestMessage()?.notification?.title === 'Packed push test'
  );
  let notifications = [];
  const deadline = Date.now() + 10000;
  while (!notifications.length && Date.now() < deadline) {
    notifications = await worker.evaluate(() => globalThis.shipNotifications);
    if (!notifications.length) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(notifications, [
    {
      title: payload.notification.title,
      options: {
        title: payload.notification.title,
        body: payload.notification.body,
        tag: payload.notification.tag,
        data: payload.notification.data,
      },
    },
  ]);
  // Inject the standard click message from the real worker. OS notification UI is
  // outside this headless fixture; actual taps remain a device acceptance check.
  await worker.evaluate(async () => {
    for (const client of await globalThis.clients.matchAll({ type: 'window' })) {
      client.postMessage({
        type: 'NOTIFICATION_CLICK',
        data: {
          action: '',
          notification: { title: 'Packed push test', data: { id: 'synthetic-1' } },
        },
      });
    }
  });
  await page.waitForFunction(
    () => globalThis.shipPushBrowser.latestClick()?.notification.title === 'Packed push test'
  );
  console.log(
    'Packed Web Push browser conformance passed: actual Angular worker, push event, showNotification boundary, click message signal; OS display and external delivery require device acceptance.'
  );
} finally {
  await browser?.close();
  await vite?.close();
  await rm(temporary, { recursive: true, force: true });
}
