import {
  DestroyRef,
  type EnvironmentProviders,
  ErrorHandler,
  inject,
  makeEnvironmentProviders,
  PLATFORM_ID,
  provideEnvironmentInitializer,
  REQUEST,
} from '@angular/core';
import { QueryClient } from '@tanstack/angular-query-experimental';
import type { ShipQueryContext } from '../browser-provider/ship-query-context';
import { SHIP_QUERY_CONTEXT } from '../browser-provider/ship-query-context-token';
import { SHIP_QUERY_REGISTRATIONS } from '../browser-provider/ship-query-registrations';
import { createShipQueryScope } from '../scope/create-ship-query-scope';
import type { ShipQueryServerConfig } from './ship-query-server-config';

/** Own one fixed cache lifetime inside an Angular SSR request injector. */
export function provideShipQueryServer(config: ShipQueryServerConfig): EnvironmentProviders {
  if (
    !config ||
    typeof config.namespace !== 'string' ||
    config.namespace.length === 0 ||
    typeof config.scopeKey !== 'string' ||
    config.scopeKey.length === 0
  ) {
    throw new TypeError('Ship query requires a namespace and a non-secret scope key.');
  }
  const namespace = config.namespace;
  const scopeKey = config.scopeKey;
  return makeEnvironmentProviders([
    { provide: SHIP_QUERY_REGISTRATIONS, multi: true, useValue: {} },
    {
      provide: SHIP_QUERY_CONTEXT,
      useFactory: (): ShipQueryContext => {
        if (inject(PLATFORM_ID) !== 'server') {
          throw new Error('Provide Ship query server only in a server request injector.');
        }
        if (inject(SHIP_QUERY_REGISTRATIONS, { self: true }).length !== 1) {
          throw new Error('Provide Ship query only once in each server request injector.');
        }
        const queryClient = new QueryClient({
          defaultOptions: {
            queries: {
              staleTime: 30000,
              gcTime: Infinity,
              retry: false,
              refetchOnMount: false,
              refetchOnWindowFocus: false,
              refetchOnReconnect: false,
            },
            mutations: { retry: false, gcTime: Infinity },
          },
        });
        const scope = createShipQueryScope({
          namespace,
          scopeKey,
          cache: queryClient,
          fixed: true,
        });
        const errorHandler = inject(ErrorHandler);
        const requestSignal = inject(REQUEST, { optional: true })?.signal;
        let ended = false;
        const end = (): void => {
          if (ended) return;
          ended = true;
          requestSignal?.removeEventListener('abort', end);
          // Invalidate the snapshot and abort work synchronously, before clearing owned state.
          void scope.destroy().catch(error => errorHandler.handleError(error));
          queryClient.clear();
        };
        inject(DestroyRef).onDestroy(end);
        if (requestSignal?.aborted) end();
        else requestSignal?.addEventListener('abort', end, { once: true });
        return Object.freeze({ queryClient, scope });
      },
    },
    {
      // The upstream providers mount clients. Server renders must not register global listeners.
      provide: QueryClient,
      useFactory: () => inject(SHIP_QUERY_CONTEXT).queryClient,
    },
    provideEnvironmentInitializer(() => {
      const context = inject(SHIP_QUERY_CONTEXT);
      if (inject(QueryClient) !== context.queryClient) {
        throw new Error('Ship query requires its owned client for native QueryClient injection.');
      }
    }),
  ]);
}
