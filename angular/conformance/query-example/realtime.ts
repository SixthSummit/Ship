import { invalidateShipQueries, type ShipQueryContext } from '@sixthsummit/ship-angular/query';

/** Application event adapter; the concrete subscription remains application-owned. */
export interface ExampleEvents {
  listen(handlers: { changed(): void; reconnected(): void; dropped(): void }): () => void;
}

export function connectExampleEvents(context: ShipQueryContext, events: ExampleEvents): () => void {
  const scope = context.scope.capture();
  let disposed = false;
  const invalidate = () => {
    if (disposed || !context.scope.isCurrent(scope)) return;
    void invalidateShipQueries(
      context,
      [
        { kind: 'operation', operationId: 'list' },
        { kind: 'operation', operationId: 'detail' },
      ],
      scope
    );
  };
  const unlisten = events.listen({
    changed: invalidate,
    reconnected: invalidate,
    dropped: invalidate,
  });
  let unregister = () => {};
  unregister = context.scope.onCleanup(scope, () => dispose());
  function dispose() {
    if (disposed) return;
    disposed = true;
    unregister();
    unlisten();
  }
  return dispose;
}
