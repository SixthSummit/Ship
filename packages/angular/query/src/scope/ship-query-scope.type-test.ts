import type { QueryClient } from '@tanstack/angular-query-experimental';
import { createShipQueryScope } from './create-ship-query-scope';
import type { ShipQueryScopeController } from './ship-query-scope-controller';
import type { ShipQueryScopeSnapshot } from './ship-query-scope-snapshot';

declare const client: QueryClient;
const scope: ShipQueryScopeController = createShipQueryScope({
  namespace: 'app@1',
  scopeKey: 'identity:tenant',
  cache: client,
});
const snapshot: ShipQueryScopeSnapshot = scope.capture();
const transition: Promise<ShipQueryScopeSnapshot> = scope.change('replacement');
const cancellation: AbortSignal = scope.signal(snapshot);
const removeListener: () => void = scope.onCleanup(snapshot, () => undefined);
const removeMutation: () => void = scope.registerMutation(snapshot, () => undefined);
const applied: boolean = scope.runIfCurrent(snapshot, () => undefined);
void [transition, cancellation, removeListener, removeMutation, applied];

// @ts-expect-error snapshots cannot be mutated by consumers
snapshot.generation = 10;
// @ts-expect-error scope identity is an application-owned string, not a live auth object
scope.change({ id: 'identity', token: 'secret' });
// @ts-expect-error every snapshot requires an explicit session generation
scope.isCurrent({ namespace: 'app@1', scopeKey: 'identity:tenant' });
// @ts-expect-error credentials are not part of the scope snapshot
void snapshot.accessToken;
