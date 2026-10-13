import type { EnvironmentProviders } from '@angular/core';
import type { QueryClient } from '@tanstack/angular-query-experimental';
import { provideShipQueryServer } from './provide-ship-query-server';

declare const unrelatedClient: QueryClient;
const provider: EnvironmentProviders = provideShipQueryServer({
  namespace: 'app@1',
  scopeKey: 'user:tenant',
});
void provider;

// @ts-expect-error the server provider always owns a fresh client for its request
provideShipQueryServer({ namespace: 'app', scopeKey: 'a', queryClient: unrelatedClient });
// @ts-expect-error application identity must be a non-secret string
provideShipQueryServer({ namespace: 'app', scopeKey: { userId: 'a' } });
// @ts-expect-error server retry policy cannot override the operation boundary
provideShipQueryServer({ namespace: 'app', scopeKey: 'a', retry: 3 });
