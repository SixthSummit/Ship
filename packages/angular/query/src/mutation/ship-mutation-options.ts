import {
  createOperationCallScope,
  createOperationMutation,
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  OperationApiError,
  type OperationCallOptions,
  type OperationClient,
  type OperationDataSuccessOf,
  OperationMutationBusyError,
} from '@sixthsummit/ship-angular/operations';
import type { CreateMutationOptions } from '@tanstack/angular-query-experimental';
import type { ShipQueryContext } from '../browser-provider/ship-query-context';
import type { ShipQueryScopeSnapshot } from '../scope/ship-query-scope-snapshot';
import { assertShipMutationConfig } from './assert-ship-mutation-config';
import { copyShipMutationCall } from './copy-ship-mutation-call';
import { raceShipMutationAbort } from './race-ship-mutation-abort';
import type { ShipMutationConfig } from './ship-mutation-config';
import type { ShipMutationEffects } from './ship-mutation-effects';
import type { ShipMutationEnvelope } from './ship-mutation-envelope';
import { registerShipMutationFactoryContext } from './ship-mutation-factory-context';
import type { ShipMutationOptionsFactory } from './ship-mutation-options-factory';

/** One operation executor, reused by every reactive evaluation of the returned native options factory. */
export function shipMutationOptions<C extends object, I extends HttpOperationId<C>, S = never>(
  client: OperationClient<C>,
  operation: I,
  context: ShipQueryContext,
  config: ShipMutationConfig<C, I, S> = {}
): ShipMutationOptionsFactory<C, I> {
  assertShipMutationConfig(config);
  const concurrency = config.concurrency ?? 'reject';
  const optimistic = config.optimistic === undefined ? undefined : { ...config.optimistic };
  const onSuccess = config.onSuccess;
  const gcTime = config.gcTime;
  const call =
    typeof config.call === 'function' ? config.call : copyShipMutationCall(config.call ?? {});
  const lifetime = new AbortController();
  let destroyed = false;
  let sequence = 0;
  let active: Invocation | undefined;
  let starting: Invocation | undefined;
  const invocations = new Set<Invocation>();

  interface Invocation {
    readonly scope: ShipQueryScopeSnapshot;
    readonly scopeSignal: AbortSignal;
    readonly controller: AbortController;
    readonly callbackController: AbortController;
    readonly call: OperationCallOptions;
    readonly effects: ShipMutationEffects;
    readonly rollbackEffects: ShipMutationEffects;
    readonly rollbackSignal: AbortSignal;
    readonly settled: Promise<void>;
  }
  interface Snapshot {
    readonly value: S;
    readonly invocation: Invocation;
  }

  const cancellableClient: OperationClient<C> = {
    call: (id, input, options) =>
      options?.signal === undefined
        ? client.call(id, input, options)
        : raceShipMutationAbort(() => client.call(id, input, options), options.signal),
  };
  // Only this constructor owns concurrency, apply, rollback, and reconciliation.
  const executor = createOperationMutation<C, I, Snapshot>(cancellableClient, operation, {
    concurrency,
    call: () => {
      if (starting === undefined) throw new Error('Ship mutation invocation is unavailable');
      return starting.call;
    },
    ...(optimistic === undefined
      ? {}
      : {
          optimistic: {
            apply: async (input: InputOf<C, I>): Promise<Snapshot> => {
              const invocation = starting;
              if (invocation === undefined)
                throw new Error('Ship mutation invocation is unavailable');
              const value = await raceShipMutationAbort(
                () => optimistic.apply(input, invocation.effects),
                invocation.scopeSignal
              );
              return { value, invocation };
            },
            rollback: async (
              snapshot: Snapshot,
              outcome: Parameters<typeof optimistic.rollback>[1]
            ) => {
              const { invocation, value } = snapshot;
              if (!invocation.rollbackEffects.isCurrent()) return;
              await raceShipMutationAbort(
                () => optimistic.rollback(value, outcome, invocation.rollbackEffects),
                invocation.rollbackSignal
              );
            },
            ...(optimistic.reconcile === undefined
              ? {}
              : {
                  reconcile: async (
                    snapshot: Snapshot,
                    data: Parameters<NonNullable<typeof optimistic.reconcile>>[1]
                  ) => {
                    const { invocation, value } = snapshot;
                    if (!invocation.effects.isCurrent()) return;
                    await raceShipMutationAbort(
                      () => optimistic.reconcile!(value, data, invocation.effects),
                      invocation.scopeSignal
                    );
                  },
                }),
          },
        }),
  });

  const execute = async (
    input: InputOf<C, I>,
    scope: ShipQueryScopeSnapshot
  ): Promise<ShipMutationEnvelope<C, I>> => {
    // A scope cancellation settles the stable executor even if its original client ignores abort.
    while (active !== undefined && !context.scope.isCurrent(active.scope)) await active.settled;
    if (destroyed || !context.scope.isCurrent(scope)) throw new OperationAbortedError();
    if (active !== undefined && concurrency === 'reject') throw new OperationMutationBusyError();

    if (active !== undefined) {
      // Take-latest also retires a previous success callback that is still awaiting application work.
      active.controller.abort();
      active.callbackController.abort();
    }

    const controls = copyShipMutationCall(typeof call === 'function' ? call(input) : call);
    const controller = new AbortController();
    const callbackController = new AbortController();
    const callbackScope = createOperationCallScope([
      context.scope.signal(scope),
      lifetime.signal,
      callbackController.signal,
    ]);
    const scopeSignal = callbackScope.signal;
    const callScope = createOperationCallScope([controls.signal, scopeSignal, controller.signal]);
    const invocationSequence = ++sequence;
    const effects: ShipMutationEffects = {
      scope,
      isCurrent: () =>
        !destroyed && sequence === invocationSequence && context.scope.isCurrent(scope),
      run: effect => {
        if (!effects.isCurrent()) return false;
        effect();
        return true;
      },
    };
    // Teardown must restore current-scope optimism, while all forward effects are disabled.
    const rollbackEffects: ShipMutationEffects = {
      scope,
      isCurrent: () => sequence === invocationSequence && context.scope.isCurrent(scope),
      run: effect => {
        if (!rollbackEffects.isCurrent()) return false;
        effect();
        return true;
      },
    };
    let release!: () => void;
    const invocation: Invocation = {
      scope,
      scopeSignal,
      controller,
      callbackController,
      call: { ...controls, signal: callScope.signal },
      effects,
      rollbackEffects,
      rollbackSignal: context.scope.signal(scope),
      settled: new Promise<void>(resolve => {
        release = resolve;
      }),
    };
    active = invocation;
    invocations.add(invocation);
    const unregister = context.scope.registerMutation(scope, () => controller.abort());
    try {
      starting = invocation;
      const pending = executor.execute(input);
      starting = undefined;
      const result = await pending;
      if (!effects.isCurrent() || callScope.signal.aborted) throw new OperationAbortedError();
      if (!result.ok) throw new OperationApiError(result);
      // The existing executor rejects 304 before resolving a success.
      const success = result as OperationDataSuccessOf<C, I>;
      const envelope: ShipMutationEnvelope<C, I> = {
        data: success.data,
        result: success,
        ...(success.headers.etag === undefined ? {} : { etag: success.headers.etag }),
      };
      if (onSuccess !== undefined) {
        await raceShipMutationAbort(() => onSuccess(envelope, input, effects), scopeSignal);
      }
      if (!effects.isCurrent() || callScope.signal.aborted) throw new OperationAbortedError();
      return envelope;
    } catch (error: unknown) {
      if (!effects.isCurrent()) throw new OperationAbortedError();
      throw error;
    } finally {
      starting = undefined;
      unregister();
      callScope.cleanup();
      callbackScope.cleanup();
      invocations.delete(invocation);
      if (active === invocation) active = undefined;
      release();
    }
  };

  const factory = (): CreateMutationOptions<
    ShipMutationEnvelope<C, I>,
    Error,
    InputOf<C, I>,
    undefined
  > => {
    const scope = context.scope.capture();
    return {
      mutationKey: [
        'ship-query',
        1,
        scope.namespace,
        scope.scopeKey,
        scope.generation,
        'mutation',
        operation,
      ],
      mutationFn: input => execute(input, scope),
      retry: false,
      networkMode: 'always',
      throwOnError: false,
      // Do not inherit another optimistic policy from QueryClient mutation defaults.
      onMutate: () => undefined,
      onSuccess: () => undefined,
      onError: () => undefined,
      onSettled: () => undefined,
      ...(gcTime === undefined ? {} : { gcTime }),
    };
  };
  const definition: ShipMutationOptionsFactory<C, I> = Object.assign(factory, {
    cancel: () => {
      if (active === undefined) return false;
      active.controller.abort();
      executor.cancel();
      return true;
    },
    destroy: async () => {
      destroyed = true;
      lifetime.abort();
      for (const invocation of invocations) invocation.controller.abort();
      executor.cancel();
      await Promise.all([...invocations].map(invocation => invocation.settled));
    },
  });
  registerShipMutationFactoryContext(definition, context);
  return definition;
}
