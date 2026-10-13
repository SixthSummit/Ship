import '@angular/compiler';
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  inject,
  provideZonelessChangeDetection,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideShipQuery } from '@sixthsummit/ship-angular/query';
import { createCandidateSession, operationProviders } from './candidate-session.mjs';

class QueryConformanceHost {
  injector = inject(Injector);
}
Component({
  selector: 'query-conformance-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})(QueryConformanceHost);

export async function createBrowserAdapter(config) {
  const element = globalThis.document.createElement('query-conformance-host');
  globalThis.document.body.append(element);
  const app = await bootstrapApplication(QueryConformanceHost, {
    providers: [
      provideZonelessChangeDetection(),
      ...operationProviders(config),
      provideShipQuery({
        namespace: 'conformance.v1',
        scopeKey: config.scopeKey,
        freshness: { gcTime: Infinity },
      }),
    ],
  });
  return createCandidateSession(app, app.components[0].instance, config, () => element.remove());
}
