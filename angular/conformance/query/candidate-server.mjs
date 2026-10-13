import '@angular/compiler';
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  inject,
  provideZonelessChangeDetection,
  REQUEST,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { INITIAL_CONFIG, platformServer } from '@angular/platform-server';
import { provideShipQueryServer } from '@sixthsummit/ship-angular/query';
import { createCandidateSession, operationProviders } from './candidate-session.mjs';

class QueryServerHost {
  injector = inject(Injector);
}
Component({
  selector: 'query-server-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})(QueryServerHost);

export async function createServerAdapter(config) {
  const request = new globalThis.Request('https://query-conformance.test/page', {
    signal: config.requestSignal,
    headers: config.requestHeaders,
  });
  const platform = platformServer([
    {
      provide: INITIAL_CONFIG,
      useValue: {
        document: '<html><body><query-server-host></query-server-host></body></html>',
        url: request.url,
      },
    },
  ]);
  const app = await bootstrapApplication(
    QueryServerHost,
    {
      providers: [
        provideZonelessChangeDetection(),
        { provide: REQUEST, useValue: request },
        ...operationProviders(config),
        provideShipQueryServer({ namespace: 'conformance.v1', scopeKey: config.scopeKey }),
      ],
    },
    { platformRef: platform }
  );
  return createCandidateSession(app, app.components[0].instance, config, () => platform.destroy());
}
