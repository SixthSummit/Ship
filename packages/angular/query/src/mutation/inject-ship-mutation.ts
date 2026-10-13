import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  Injector,
  inject,
  signal,
} from '@angular/core';
import {
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
} from '@sixthsummit/ship-angular/operations';
import { MutationObserver, QueryClient } from '@tanstack/angular-query-experimental';
import type { ShipQueryScopeSnapshot } from '../scope/ship-query-scope-snapshot';
import type { ShipMutationEnvelope } from './ship-mutation-envelope';
import { getShipMutationFactoryContext } from './ship-mutation-factory-context';
import type { ShipMutationOptionsFactory } from './ship-mutation-options-factory';
import type { ShipMutationView } from './ship-mutation-view';

/** Native MutationObserver owns state. This projection adds synchronous identity masking only. */
export function injectShipMutation<C extends object, I extends HttpOperationId<C>>(
  factory: ShipMutationOptionsFactory<C, I>,
  options?: { readonly injector?: Injector }
): ShipMutationView<C, I> {
  if (options?.injector === undefined) assertInInjectionContext(injectShipMutation);
  const injector = options?.injector ?? inject(Injector);
  const context = getShipMutationFactoryContext(factory);
  if (injector.get(QueryClient) !== context.queryClient) {
    throw new Error('Ship mutation requires its owned QueryClient');
  }
  const observer = new MutationObserver<
    ShipMutationEnvelope<C, I>,
    Error,
    InputOf<C, I>,
    undefined
  >(context.queryClient, factory());
  const native = signal(observer.getCurrentResult());
  const observedScope = signal<ShipQueryScopeSnapshot | undefined>(undefined);
  const destroyed = signal(false);
  const unsubscribe = observer.subscribe(result => native.set(result));
  let removeScopeListener: (() => void) | undefined;
  const visible = computed(() => {
    const captured = observedScope();
    return !destroyed() && captured !== undefined && context.scope.isCurrent(captured)
      ? native()
      : undefined;
  });
  injector.get(DestroyRef).onDestroy(() => {
    destroyed.set(true);
    removeScopeListener?.();
    unsubscribe();
    observer.reset();
  });

  const mutateAsync = async (input: InputOf<C, I>): Promise<ShipMutationEnvelope<C, I>> => {
    if (destroyed()) throw new OperationAbortedError();
    const captured = context.scope.capture();
    if (!context.scope.isCurrent(captured)) throw new OperationAbortedError();
    // Refresh synchronously: native options effects must not lag the generation at call time.
    observer.setOptions(factory());
    removeScopeListener?.();
    observedScope.set(captured);
    removeScopeListener = context.scope.onCleanup(captured, () => {
      observedScope.set(undefined);
      // Native reset detaches the observer. It does not reset the active operation executor.
      observer.reset();
    });
    try {
      const result = await observer.mutate(input);
      if (destroyed() || !context.scope.isCurrent(captured)) throw new OperationAbortedError();
      return result;
    } catch (error: unknown) {
      if (destroyed() || !context.scope.isCurrent(captured)) throw new OperationAbortedError();
      throw error;
    }
  };

  return {
    data: computed(() => visible()?.data),
    error: computed(() => visible()?.error ?? null),
    variables: computed(() => visible()?.variables),
    status: computed(() => visible()?.status ?? 'idle'),
    isPending: computed(() => visible()?.isPending ?? false),
    isSuccess: computed(() => visible()?.isSuccess ?? false),
    isError: computed(() => visible()?.isError ?? false),
    isIdle: computed(() => visible()?.isIdle ?? true),
    isPaused: computed(() => visible()?.isPaused ?? false),
    failureCount: computed(() => visible()?.failureCount ?? 0),
    failureReason: computed(() => visible()?.failureReason ?? null),
    submittedAt: computed(() => visible()?.submittedAt ?? 0),
    mutate: input => {
      void mutateAsync(input).catch(() => undefined);
    },
    mutateAsync,
    cancel: () => factory.cancel(),
    reset: () => observer.reset(),
  };
}
