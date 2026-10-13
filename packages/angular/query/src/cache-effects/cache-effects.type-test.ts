import { type InfiniteData, queryOptions } from '@tanstack/angular-query-experimental';
import type { ShipQueryContext } from '../browser-provider/ship-query-context';
import type { ShipQueryKey, ShipQueryScopeSnapshot } from '../keys/ship-query-key';
import type { ShipQueryInvalidationTarget } from './ship-query-invalidation-target';
import { updateShipQueryData } from './update-ship-query-data';

declare const context: ShipQueryContext;
declare const captured: ShipQueryScopeSnapshot;
declare const key: ShipQueryKey;
type Envelope = {
  data: { name: string };
  result: {
    ok: true;
    status: 200;
    data: { name: string };
    headers: { headers: Record<string, string> };
  };
};
declare const envelope: Envelope;
const finite = queryOptions({ queryKey: key, queryFn: async () => envelope });
const updated: Envelope | undefined = updateShipQueryData(
  context,
  finite.queryKey,
  previous => {
    const name: string | undefined = previous?.data.name;
    void name;
    return envelope;
  },
  captured
);
void updated;
updateShipQueryData<Envelope>(context, key, previous => previous ?? envelope, captured);
updateShipQueryData(
  context,
  finite.queryKey,
  // @ts-expect-error a tagged operation body retains its field types
  previous => ({ ...envelope, data: { name: 42 } }),
  captured
);
// @ts-expect-error an async updater cannot make a guarded synchronous cache write
updateShipQueryData(context, finite.queryKey, async () => envelope, captured);
// @ts-expect-error an untagged key cannot infer arbitrary primitive cache data
updateShipQueryData(context, key, () => 'body', captured);
// @ts-expect-error explicit generics must also describe a query envelope
updateShipQueryData<string>(context, key, () => 'body', captured);
updateShipQueryData(
  context,
  finite.queryKey,
  // @ts-expect-error updater parameters cannot override inference from a tagged key
  (_previous: string | undefined) => envelope,
  captured
);
declare const pages: InfiniteData<Envelope, number>;
const infinite = queryOptions({ queryKey: key, queryFn: async () => pages });
const infiniteResult: InfiniteData<Envelope, number> | undefined = updateShipQueryData(
  context,
  infinite.queryKey,
  previous => {
    const name: string | undefined = previous?.pages[0]?.data.name;
    void name;
    return pages;
  },
  captured
);
void infiniteResult;
const exact: ShipQueryInvalidationTarget = { kind: 'exact', key };
const operation: ShipQueryInvalidationTarget = { kind: 'operation', operationId: 'account.get' };
void exact;
void operation;
// @ts-expect-error invalidation cannot select the whole application cache
const wildcard: ShipQueryInvalidationTarget = { kind: 'all' };
void wildcard;
