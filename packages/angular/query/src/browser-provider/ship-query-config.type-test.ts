import type { EnvironmentProviders } from '@angular/core';
import { provideShipQuery } from './provide-ship-query';
import type { ShipQueryConfig } from './ship-query-config';

const config: ShipQueryConfig = {
  namespace: 'api@1',
  scopeKey: 'anonymous',
  freshness: { staleTime: 10000, gcTime: Infinity, refetchOnReconnect: 'always' },
};
const providers: EnvironmentProviders = provideShipQuery(config);
void providers;
provideShipQuery({
  namespace: 'api@1',
  scopeKey: 'user:1',
  freshness: {
    // @ts-expect-error retry belongs to the operation policy
    retry: true,
  },
});
provideShipQuery({
  namespace: 'api@1',
  scopeKey: 'user:1',
  freshness: {
    // @ts-expect-error query functions belong to each query adapter
    queryFn: () => Promise.resolve('data'),
  },
});
provideShipQuery({
  namespace: 'api@1',
  scopeKey: 'user:1',
  freshness: {
    // @ts-expect-error functions are excluded from public default configuration
    refetchOnMount: () => true,
  },
});
// @ts-expect-error a scope key is mandatory
provideShipQuery({ namespace: 'api@1' });
