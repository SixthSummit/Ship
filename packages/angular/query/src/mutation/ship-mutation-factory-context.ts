import type { ShipQueryContext } from '../browser-provider/ship-query-context';

const contexts = new WeakMap<object, ShipQueryContext>();

export function registerShipMutationFactoryContext(
  factory: object,
  context: ShipQueryContext
): void {
  contexts.set(factory, context);
}

export function getShipMutationFactoryContext(factory: object): ShipQueryContext {
  const context = contexts.get(factory);
  if (context === undefined) throw new TypeError('Expected a shipMutationOptions factory');
  return context;
}
