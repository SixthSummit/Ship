import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
export async function runJointBrowser(root) {
  root = await fs.realpath(root);
  const { startFixture } = await import(
    pathToFileURL(path.join(root, 'node_modules/@sixthsummit/ship-api-conformance-server/index.js'))
  );
  const fixture = await startFixture();
  let vite, browser;
  try {
    await fs.writeFile(
      path.join(root, 'index.html'),
      '<html><body>Real generated ShipAPI joint conformance<script type="module">import {run} from "/browser.ts"; globalThis.__JOINT_PROMISE__=run();</script></body></html>'
    );
    vite = await createServer({
      root,
      configFile: false,
      logLevel: 'error',
      define: { __FIXTURE_ORIGIN__: JSON.stringify(fixture.origin) },
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    await page.waitForFunction(() => globalThis.__JOINT_PROMISE__ !== undefined);
    const report = await page.evaluate(() => globalThis.__JOINT_PROMISE__);
    if (!fixture.captures.some(h => h.__path.startsWith('/status')))
      throw new Error('Browser cancellation never reached I/O');
    const session = fixture.captures.filter(
      h => h.__path.startsWith('/session/') && h.__method !== 'OPTIONS'
    );
    if (
      JSON.stringify(session.map(h => h.__path)) !==
        JSON.stringify(['/session/me', '/session/refresh', '/session/me', '/session/sign-out']) ||
      session.some(h => !h.cookie?.includes('sid=browser-fixture'))
    )
      throw new Error('Browser cookie refresh sequence did not reach the server');
    return report;
  } finally {
    await browser?.close();
    await vite?.close();
    await fixture.close();
  }
}
