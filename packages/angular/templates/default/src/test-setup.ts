// Must be first: installs Web Streams globals before msw/node loads.
import './test-polyfills';
// i18n: templates use i18n attributes, which compile to $localize calls.
import '@angular/localize/init';
import { provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { server } from './mocks/node';

// Zoneless test environment — matches the runtime contract from app.config.ts.
// Components must be OnPush + signal-driven (enforced by ESLint custom rules).
getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), {
  teardown: { destroyAfterEach: true },
  errorOnUnknownElements: true,
  errorOnUnknownProperties: true,
});

// Apply zoneless CD to TestBed by default. beforeEach (not beforeAll): the
// TestBed resets after every test (destroyAfterEach), which would drop a
// provider registered only once. Tests can still override per-test if they
// need zone-based behavior (rare; only legacy code under migration).
beforeEach(() => {
  getTestBed().configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  });
});

// MSW for HTTP mocking in tests. Disabled by default for tests that don't
// need it via `bypass`; see https://mswjs.io/docs/api/setup-server.
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
