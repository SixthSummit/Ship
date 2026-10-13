import { canonicalizeKeyValue } from './canonicalize-key-value';
import type {
  ShipQueryKey,
  ShipQueryKeyValue,
  ShipQueryMode,
  ShipQueryScopeSnapshot,
} from './ship-query-key';
import { assertShipReadBinding } from './ship-read-binding';

/** Build a detached key for one input, response variant, and immutable scope snapshot. */
export function createShipQueryKey<TInput, TId extends string>(
  binding: {
    readonly operationId: TId;
    readonly safety: 'safe';
    readonly inputKey: (input: TInput) => ShipQueryKeyValue;
    readonly variantKey: ShipQueryKeyValue;
  },
  input: NoInfer<TInput>,
  scope: ShipQueryScopeSnapshot,
  mode: ShipQueryMode
): ShipQueryKey {
  assertShipReadBinding(binding);
  if (
    !scope ||
    typeof scope.namespace !== 'string' ||
    scope.namespace.length === 0 ||
    typeof scope.scopeKey !== 'string' ||
    scope.scopeKey.length === 0 ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 0
  ) {
    throw new TypeError('Query keys require a namespace, scope key, and non-negative generation.');
  }
  if (mode !== 'finite' && mode !== 'infinite') {
    throw new TypeError('Query keys require finite or infinite mode.');
  }
  return Object.freeze([
    'ship-query',
    1,
    scope.namespace,
    scope.scopeKey,
    scope.generation,
    mode,
    binding.operationId,
    canonicalizeKeyValue(binding.variantKey),
    canonicalizeKeyValue(binding.inputKey(input)),
  ]);
}
