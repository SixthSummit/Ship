import type { Signal } from '@angular/core';
import type { HttpOperationId, InputOf } from '@sixthsummit/ship-angular/operations';
import type { MutationStatus } from '@tanstack/angular-query-experimental';
import type { ShipMutationEnvelope } from './ship-mutation-envelope';

/** Signal projection of native mutation state, hidden immediately outside its captured scope. */
export interface ShipMutationView<C extends object, I extends HttpOperationId<C>> {
  readonly data: Signal<ShipMutationEnvelope<C, I> | undefined>;
  readonly error: Signal<Error | null>;
  readonly variables: Signal<InputOf<C, I> | undefined>;
  readonly status: Signal<MutationStatus>;
  readonly isPending: Signal<boolean>;
  readonly isSuccess: Signal<boolean>;
  readonly isError: Signal<boolean>;
  readonly isIdle: Signal<boolean>;
  readonly isPaused: Signal<boolean>;
  readonly failureCount: Signal<number>;
  readonly failureReason: Signal<Error | null>;
  readonly submittedAt: Signal<number>;
  mutate(input: InputOf<C, I>): void;
  mutateAsync(input: InputOf<C, I>): Promise<ShipMutationEnvelope<C, I>>;
  cancel(): boolean;
  /** Reset the native observer only; this neither cancels nor resets an active operation executor. */
  reset(): void;
}
