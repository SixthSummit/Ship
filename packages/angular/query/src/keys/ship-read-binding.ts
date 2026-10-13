import type {
  HttpOperationId,
  InputOf,
  OperationPolicyMap,
  OperationSafety,
} from '@sixthsummit/ship-angular/operations';
import { canonicalizeKeyValue } from './canonicalize-key-value';
import type { ShipQueryKeyValue } from './ship-query-key';

/** Application declaration of a safe unary read. Include every response variant in its keys. */
export interface ShipReadBinding<TContract extends object, TId extends HttpOperationId<TContract>> {
  readonly operationId: TId;
  readonly safety: 'safe';
  readonly inputKey: (input: InputOf<TContract, TId>) => ShipQueryKeyValue;
  readonly variantKey: ShipQueryKeyValue;
}

/** Check safety again at execution boundaries, including callers that bypass TypeScript. */
export function assertShipReadBinding<TPolicy extends { readonly safety: OperationSafety }>(
  binding: {
    readonly operationId: string;
    readonly safety: 'safe';
    readonly inputKey: unknown;
  },
  policies?: Readonly<Record<string, TPolicy | undefined>>
): void {
  if (!binding || binding.safety !== 'safe') {
    throw new TypeError('Query read bindings require explicit safe operation safety.');
  }
  if (typeof binding.operationId !== 'string' || binding.operationId.length === 0) {
    throw new TypeError('Query read bindings require an operation ID.');
  }
  if (typeof binding.inputKey !== 'function') {
    throw new TypeError('Query read bindings require an input key mapper.');
  }
  const policy = policies?.[binding.operationId];
  if (policy && policy.safety !== 'safe') {
    throw new TypeError('Query read binding safety conflicts with the operation policy.');
  }
}

/** Fix the contract once, then infer each operation ID and its input independently. */
export function defineShipReadBinding<TContract extends object>() {
  return <TId extends HttpOperationId<TContract>>(
    binding: ShipReadBinding<TContract, TId>,
    policies?: Partial<OperationPolicyMap<TContract>>
  ): ShipReadBinding<TContract, TId> => {
    assertShipReadBinding(binding, policies);
    return Object.freeze({
      operationId: binding.operationId,
      safety: binding.safety,
      inputKey: binding.inputKey,
      variantKey: canonicalizeKeyValue(binding.variantKey),
    });
  };
}
