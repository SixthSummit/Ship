import {
  DestroyRef,
  type EnvironmentProviders,
  ErrorHandler,
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { provideTanStackQuery, QueryClient } from '@tanstack/angular-query-experimental';
import { createShipQueryScope } from '../scope/create-ship-query-scope';
import { resolveShipQueryFreshness } from './resolve-ship-query-freshness';
import type { ShipQueryConfig } from './ship-query-config';
import type { ShipQueryContext } from './ship-query-context';
import { SHIP_QUERY_CONTEXT } from './ship-query-context-token';
import { SHIP_QUERY_REGISTRATIONS } from './ship-query-registrations';

const SHIP_QUERY_OWNED_CLIENT = new InjectionToken<QueryClient>('ShipQueryOwnedClient');

/** Own one browser cache and scope. Each injector creates its own client during initialization. */
export function provideShipQuery(config: ShipQueryConfig): EnvironmentProviders {
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
  const freshness = resolveShipQueryFreshness(config.freshness);
  return makeEnvironmentProviders([
    { provide: SHIP_QUERY_REGISTRATIONS, multi: true, useValue: {} },
    {
      provide: SHIP_QUERY_CONTEXT,
      useFactory: (): ShipQueryContext => {
        if (inject(SHIP_QUERY_REGISTRATIONS, { self: true }).length !== 1) {
          throw new Error('Provide Ship query only once in each application injector.');
        }
        const queryClient = new QueryClient({
          defaultOptions: {
            queries: { ...freshness, retry: false },
            mutations: { retry: false },
          },
        });
        const scope = createShipQueryScope({ namespace, scopeKey, cache: queryClient });
        const errorHandler = inject(ErrorHandler);
        inject(DestroyRef).onDestroy(() => {
          // Scope destruction aborts requests and invalidates its snapshot synchronously.
          void scope.destroy().catch(error => errorHandler.handleError(error));
          queryClient.clear();
        });
        return Object.freeze({ queryClient, scope });
      },
    },
    {
      provide: SHIP_QUERY_OWNED_CLIENT,
      useFactory: () => inject(SHIP_QUERY_CONTEXT).queryClient,
    },
    ...provideTanStackQuery(SHIP_QUERY_OWNED_CLIENT),
    provideEnvironmentInitializer(() => {
      // Eager initialization detects duplicate registration before the application starts.
      const context = inject(SHIP_QUERY_CONTEXT);
      if (inject(QueryClient) !== context.queryClient) {
        throw new Error('Ship query requires its owned client for native QueryClient injection.');
      }
    }),
  ]);
}
