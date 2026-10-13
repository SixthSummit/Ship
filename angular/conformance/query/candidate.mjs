import '@angular/compiler';
// Node entrypoint. The browser runner imports candidate-browser directly and never bundles jsdom/server code.

import { destroyPlatform, enableProdMode } from '@angular/core';
// Public import is intentional evidence for the physical archive validator.
import { shipQueryOptions } from '@sixthsummit/ship-angular/query';
import { JSDOM } from 'jsdom';
import { createBrowserAdapter } from './candidate-browser.mjs';
import { createServerAdapter } from './candidate-server.mjs';

void shipQueryOptions;

enableProdMode();
const dom = new JSDOM('<html><body></body></html>', { url: 'https://query-conformance.test' });
for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Event', 'CustomEvent'])
  globalThis[name] = dom.window[name];
let mode;
export async function createQueryAdapter(config) {
  if (mode !== config.mode) {
    destroyPlatform();
    mode = config.mode;
  }
  return config.mode === 'server' ? createServerAdapter(config) : createBrowserAdapter(config);
}
