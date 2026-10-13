import { computed, type Signal, signal } from '@angular/core';
import { composeAbortSignals } from './compose-abort-signals';
import { OperationAbortedError } from './operation-aborted-error';
import { OperationApiError } from './operation-api-error';
import type { OperationCallOptions, OperationClient } from './operation-client';
import type { HttpOperationId, InputOf } from './operation-contract';
import { OperationMutationBusyError } from './operation-mutation-busy-error';
import { OperationMutationRollbackError } from './operation-mutation-rollback-error';
import type {
  OperationDataOf,
  OperationFailure,
  OperationFailureOf,
  OperationResultOf,
} from './operation-result';
import { ProtocolError } from './protocol-error';

export type OperationMutationStatus =
  | 'idle'
  | 'pending'
  | 'success'
  | 'failure'
  | 'error'
  | 'aborted';

export type OperationMutationConcurrency = 'reject' | 'take-latest';

export interface OperationOptimisticPolicy<TInput, TData, TSnapshot> {
  readonly apply: (input: TInput) => TSnapshot | Promise<TSnapshot>;
  readonly rollback: (
    snapshot: TSnapshot,
    outcome: OperationFailure<string> | Error
  ) => void | Promise<void>;
  readonly reconcile?: (snapshot: TSnapshot, data: TData) => void | Promise<void>;
}

export interface CreateOperationMutationOptions<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TSnapshot,
> {
  /** Reject overlapping calls by default. Take-latest is available for non-optimistic actions. */
  readonly concurrency?: OperationMutationConcurrency;
  readonly call?: OperationCallOptions | ((input: InputOf<TContract, TId>) => OperationCallOptions);
  readonly optimistic?: OperationOptimisticPolicy<
    InputOf<TContract, TId>,
    OperationDataOf<TContract, TId>,
    TSnapshot
  >;
}

interface OperationMutationState<TContract extends object, TId extends HttpOperationId<TContract>> {
  readonly status: OperationMutationStatus;
  readonly input?: InputOf<TContract, TId>;
  readonly result?: OperationResultOf<TContract, TId>;
  readonly data?: OperationDataOf<TContract, TId>;
  readonly failure?: OperationFailureOf<TContract, TId>;
  readonly error?: Error;
}

/** Signal state and imperative execution surface for a typed mutation operation. */
export interface OperationMutation<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
> {
  readonly status: Signal<OperationMutationStatus>;
  readonly pending: Signal<boolean>;
  readonly input: Signal<InputOf<TContract, TId> | undefined>;
  readonly result: Signal<OperationResultOf<TContract, TId> | undefined>;
  readonly data: Signal<OperationDataOf<TContract, TId> | undefined>;
  readonly failure: Signal<OperationFailureOf<TContract, TId> | undefined>;
  readonly error: Signal<Error | undefined>;
  execute(input: InputOf<TContract, TId>): Promise<OperationResultOf<TContract, TId>>;
  cancel(): boolean;
  reset(): void;
}

/**
 * Create an imperative mutation with explicit concurrency, cancellation, and optimistic rollback.
 * Declared API failures resolve as values; exceptional failures reject.
 */
export function createOperationMutation<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TSnapshot = never,
>(
  client: OperationClient<TContract>,
  operation: TId,
  options: CreateOperationMutationOptions<TContract, TId, TSnapshot> = {}
): OperationMutation<TContract, TId> {
  const concurrency = options.concurrency ?? 'reject';
  if (concurrency === 'take-latest' && options.optimistic !== undefined) {
    throw new Error('Optimistic mutations cannot use take-latest concurrency');
  }

  const state = signal<OperationMutationState<TContract, TId>>({ status: 'idle' });
  let active: AbortController | undefined;
  let generation = 0;

  const execute = async (
    input: InputOf<TContract, TId>
  ): Promise<OperationResultOf<TContract, TId>> => {
    if (active !== undefined) {
      if (concurrency === 'reject') throw new OperationMutationBusyError();
      active.abort();
    }

    const controller = new AbortController();
    active = controller;
    generation += 1;
    const execution = generation;
    state.set({ status: 'pending', input });

    let optimisticApplied = false;
    let rolledBack = false;
    let snapshot!: TSnapshot;
    const rollback = async (outcome: OperationFailure<string> | Error): Promise<void> => {
      if (!optimisticApplied || rolledBack || options.optimistic === undefined) return;
      rolledBack = true;
      await options.optimistic.rollback(snapshot, outcome);
    };

    let callScope: ReturnType<typeof composeAbortSignals> | undefined;
    try {
      const configuredCall =
        typeof options.call === 'function' ? options.call(input) : (options.call ?? {});
      callScope = composeAbortSignals([controller.signal, configuredCall.signal]);
      if (callScope.signal.aborted) throw new OperationAbortedError();
      if (options.optimistic !== undefined) {
        snapshot = await options.optimistic.apply(input);
        optimisticApplied = true;
      }
      if (callScope.signal.aborted) throw new OperationAbortedError();

      const result = await client.call(operation, input, {
        ...configuredCall,
        signal: callScope.signal,
      });
      if (callScope.signal.aborted) throw new OperationAbortedError();

      if (!result.ok) {
        const failure = result as OperationFailureOf<TContract, TId>;
        try {
          await rollback(failure);
        } catch (rollbackError: unknown) {
          throw new OperationMutationRollbackError(
            'Operation failure and optimistic rollback both failed',
            new OperationApiError(failure),
            normalizeUnknownError(rollbackError)
          );
        }
        if (execution === generation) {
          state.set({
            status: 'failure',
            input,
            result,
            failure,
          });
        }
        return result;
      }

      if (!('data' in result)) {
        throw new ProtocolError('Mutation operation returned 304 without a response value', {
          reason: 'unexpected-status',
          status: result.status,
          metadata: result.headers,
        });
      }

      const data = result.data as OperationDataOf<TContract, TId>;
      if (options.optimistic?.reconcile !== undefined) {
        await options.optimistic.reconcile(snapshot, data);
      }
      if (execution === generation) {
        state.set({ status: 'success', input, result, data });
      }
      return result;
    } catch (caught: unknown) {
      let error = normalizeMutationError(caught, callScope?.signal ?? controller.signal);
      try {
        await rollback(error);
      } catch (rollbackError: unknown) {
        error = new OperationMutationRollbackError(
          'Operation mutation and optimistic rollback both failed',
          error,
          normalizeUnknownError(rollbackError)
        );
      }
      if (execution === generation) {
        state.set({
          status: error instanceof OperationAbortedError ? 'aborted' : 'error',
          input,
          error,
        });
      }
      throw error;
    } finally {
      callScope?.cleanup();
      if (execution === generation) active = undefined;
    }
  };

  return {
    status: computed(() => state().status),
    pending: computed(() => state().status === 'pending'),
    input: computed(() => state().input),
    result: computed(() => state().result),
    data: computed(() => state().data),
    failure: computed(() => state().failure),
    error: computed(() => state().error),
    execute,
    cancel: () => {
      if (active === undefined) return false;
      active.abort();
      return true;
    },
    reset: () => {
      if (active !== undefined) throw new OperationMutationBusyError();
      state.set({ status: 'idle' });
    },
  };
}

function normalizeMutationError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new OperationAbortedError();
  return normalizeUnknownError(error);
}

function normalizeUnknownError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error('Operation mutation failed with a non-Error value');
}
