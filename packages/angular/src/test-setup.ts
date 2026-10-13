/**
 * Vitest setup for the framework's own unit tests.
 *
 * - jsdom environment (configured in vitest.config.ts) — gives us
 *   `window`, `document`, etc. so Angular's TestBed can render.
 * - Zoneless TestBed configured by default — matches the runtime
 *   contract the framework ships.
 *
 * Tests use `TestBed.configureTestingModule({ providers: [...] })` and
 * `TestBed.inject(...)` (or `TestBed.runInInjectionContext(...)`) for
 * DI-dependent code. See AuthService.spec.ts for canonical patterns.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { getTestBed, TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll } from 'vitest';

beforeAll(() => {
  getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), {
    teardown: { destroyAfterEach: true },
    errorOnUnknownElements: true,
    errorOnUnknownProperties: true,
  });
});

afterEach(() => {
  TestBed.resetTestingModule();
});

/**
 * Convenience for tests that need an injection context outside a TestBed
 * fixture. Configures the testing module with zoneless change detection
 * + the supplied providers, returns the configured `TestBed`.
 */
export function configureZonelessTestBed(providers: Array<unknown> = []): typeof TestBed {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), ...providers],
  });
  return TestBed;
}
