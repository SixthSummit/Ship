import type {
  HttpOperationId,
  InputOf,
  OperationCallOptions,
  OperationDataOf,
  OperationFailure,
  OperationMutationConcurrency,
} from '@sixthsummit/ship-angular/operations';
import type { ShipMutationEffects } from './ship-mutation-effects';
import type { ShipMutationEnvelope } from './ship-mutation-envelope';

export interface ShipMutationConfig<C extends object, I extends HttpOperationId<C>, S = never> {
  readonly call?: OperationCallOptions | ((input: InputOf<C, I>) => OperationCallOptions);
  readonly concurrency?: OperationMutationConcurrency;
  readonly gcTime?: number;
  readonly optimistic?: {
    readonly apply: (input: InputOf<C, I>, effects: ShipMutationEffects) => S | Promise<S>;
    readonly rollback: (
      snapshot: S,
      outcome: OperationFailure<string> | Error,
      effects: ShipMutationEffects
    ) => void | Promise<void>;
    readonly reconcile?: (
      snapshot: S,
      data: OperationDataOf<C, I>,
      effects: ShipMutationEffects
    ) => void | Promise<void>;
  };
  /** Stable essential effects. Use effects.run for writes and explicit targets for invalidation. */
  readonly onSuccess?: (
    envelope: ShipMutationEnvelope<C, I>,
    input: InputOf<C, I>,
    effects: ShipMutationEffects
  ) => void | Promise<void>;
}
