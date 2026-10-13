import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';

import {
  applySecurityHeaders,
  type SecurityHeadersConfig,
} from './server-middleware/securityHeaders';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// CSP + Trusted Types are production-only: the dev server (`ng serve`)
// injects `@vite/client`, `polyfills.js`, and `main.js` without nonces, so
// the strict nonce CSP would block the entire client app in development
// (the SSR shell renders, then nothing hydrates). The Dockerfile sets
// NODE_ENV=production, so deployed apps always get the full policy; the rest
// of the header stack stays on in both modes.
const isProd = process.env['NODE_ENV'] === 'production';

const securityConfig: SecurityHeadersConfig = {
  ...(isProd
    ? {
        // Strict CSP (nonce-based). Tighten further per-app as needed.
        csp: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'strict-dynamic'", '__nonce__'],
          'style-src': ["'self'", "'unsafe-inline'"], // unsafe:reason: Tailwind v4's runtime injection requires inline styles. Phase 2.x: move to nonce-based.
          'img-src': ["'self'", 'data:', 'https:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'", 'https://*.googleapis.com', 'https://*.firebaseio.com'],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': [],
        },
        trustedTypes: true,
      }
    : {}),
  hsts: {
    maxAge: 60 * 60 * 24 * 365, // 1 year
    includeSubDomains: true,
    preload: false,
  },
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: {
    accelerometer: [],
    camera: [],
    geolocation: [],
    gyroscope: [],
    microphone: [],
    payment: [],
    usb: [],
  },
};

// Generate a per-request nonce so Trusted Types + CSP work cleanly with
// SSR. The nonce is read by Angular's Trusted Types support and emitted in
// rendered <script> tags via the rendering hook.
app.use((req, res, next) => {
  const nonce = randomBytes(16).toString('base64url');
  res.locals['cspNonce'] = nonce;
  applySecurityHeaders(res, securityConfig, nonce);
  next();
});

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  })
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then(response => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = process.env['PORT'] ?? 4000;
  app.listen(Number(port), () => {
    console.log(`SSR server listening on port ${port}`);
  });
}

/**
 * Cloud Run / Functions-style request handler — exported so a serverless
 * runtime can mount the app without a long-running listener.
 */
export const reqHandler = createNodeRequestHandler(app);

/**
 * Express app, exported for test harnesses (e.g., supertest) and custom
 * embeddings.
 */
/**
 * Resolved browser dist directory; useful for tests that need to assert
 * generated assets.
 */
export { app, browserDistFolder, join };
