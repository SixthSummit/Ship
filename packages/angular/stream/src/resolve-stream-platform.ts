import { isPlatformBrowser } from '@angular/common';
import { inject, PLATFORM_ID } from '@angular/core';

/** Where a stream is being created: the browser, or a server render. */
export type ShipStreamPlatform = 'browser' | 'server';

/**
 * Decide whether a stream may open a request.
 *
 * Mirrors `./operations`' SSR context: `PLATFORM_ID` is authoritative when an
 * injection context exists. Outside one — a plain unit test, a worker — the
 * presence of `document` decides. An explicit option always wins, so an SSR
 * render test can assert the server branch without an injector.
 */
export function resolveStreamPlatform(
  explicit: ShipStreamPlatform | undefined
): ShipStreamPlatform {
  if (explicit !== undefined) return explicit;
  const platformId = injectPlatformId();
  if (platformId === undefined) {
    return typeof globalThis.document === 'undefined' ? 'server' : 'browser';
  }
  return isPlatformBrowser(platformId) ? 'browser' : 'server';
}

function injectPlatformId(): object | undefined {
  try {
    return inject(PLATFORM_ID, { optional: true }) ?? undefined;
  } catch {
    // createStream is allowed outside an injection context; fall back to the runtime.
    return undefined;
  }
}
