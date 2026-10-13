import { InjectionToken, runInInjectionContext } from '@angular/core';
import {
  createOperationRequestPolicy,
  createPolicyClientFromPolicy,
  createShipClientToken,
  provideShipOperationBoundary,
} from '@sixthsummit/ship-angular/operations';
import {
  createShipQueryKey,
  defineShipReadBinding,
  injectShipInfiniteQuery,
  injectShipMutation,
  injectShipQuery,
  invalidateShipQueries,
  SHIP_QUERY_CONTEXT,
  shipMutationOptions,
  shipQueryOptions,
} from '@sixthsummit/ship-angular/query';
import { isCancelledError } from '@tanstack/angular-query-experimental';

export const CLIENT = createShipClientToken('QueryConformanceClient');
const POLICY = new InjectionToken('QueryConformancePolicy');
const binding = defineShipReadBinding()({
  operationId: 'fixture.read',
  safety: 'safe',
  inputKey: input => input,
  variantKey: null,
});

export function operationProviders(config) {
  return provideShipOperationBoundary(
    CLIENT,
    POLICY,
    context => {
      const policy = createOperationRequestPolicy({
        policies: {
          'fixture.read': {
            authentication: 'optional',
            safety: 'safe',
            idempotency: 'unsupported',
            replayable: true,
            ...(config.policyRetry
              ? { retry: { maxAttempts: config.policyRetry + 1, statuses: [503] } }
              : {}),
          },
          'fixture.write': {
            authentication: 'optional',
            safety: 'unsafe',
            idempotency: 'unsupported',
            replayable: false,
          },
        },
        credentials: { kind: 'cookie' },
        baseHeaders: context.forwardedHeaders,
      });
      return {
        client: createPolicyClientFromPolicy(config.client, policy, {
          signal: context.signal,
          delay: async () => {},
        }),
        requestPolicy: policy,
      };
    },
    {
      apiBaseUrl: 'https://query-conformance.test',
      forwarding: { cookieNames: ['session'] },
      trackPendingTasks: config.trackPendingTasks ?? true,
    }
  );
}

/** Pure delegation bridge: no custom cache, retry, identity mask, or result conversion. */
export function createCandidateSession(app, host, config, afterDestroy = () => {}) {
  const context = app.injector.get(SHIP_QUERY_CONTEXT);
  const client = app.injector.get(CLIENT);
  const factories = new Set();
  const views = new Map(); // Actual guarded observer handles, not a second state store.
  const pages = new Map(); // Observer handles only; native Query owns all page data.
  return {
    clientIdentity: context.queryClient,
    isCancellation: isCancelledError,
    app,
    context,
    read(input, options = {}) {
      const view = views.get(JSON.stringify(input));
      if (view && options.force)
        return view.refetch({ throwOnError: true }).then(result => result.data);
      return context.queryClient.fetchQuery(
        shipQueryOptions(client, binding, input, context, {
          ...(options.force ? { staleTime: 0 } : {}),
          ...(options.signal ? { call: { signal: options.signal } } : {}),
        })
      );
    },
    view(input) {
      const query = runInInjectionContext(host.injector, () =>
        injectShipQuery(client, binding, () => input, context)
      );
      views.set(JSON.stringify(input), query);
      app.tick();
      return () => ({ data: query.data(), error: query.error() });
    },
    invalidate(input) {
      const captured = context.scope.capture();
      return invalidateShipQueries(
        context,
        [{ kind: 'exact', key: createShipQueryKey(binding, input, captured, 'finite') }],
        captured
      );
    },
    async page(input, cursor) {
      const key = JSON.stringify(input);
      let query = pages.get(key);
      if (!query) {
        query = runInInjectionContext(host.injector, () =>
          injectShipInfiniteQuery(client, binding, () => input, context, {
            initialPageParam: cursor,
            buildInput: (base, pageParam) => ({ ...base, cursor: pageParam }),
            getNextPageParam: envelope => envelope.data.next ?? undefined,
          })
        );
        pages.set(key, query);
        app.tick();
        return (await query.refetch()).data;
      }
      return (await query.fetchNextPage()).data;
    },
    changeScope: next => context.scope.change(next),
    mutation(callbacks = {}) {
      const factory = shipMutationOptions(client, 'fixture.write', context, {
        gcTime: 0,
        ...callbacks,
      });
      factories.add(factory);
      const mutation = runInInjectionContext(host.injector, () => injectShipMutation(factory));
      return {
        execute: input => mutation.mutateAsync(input),
        view: () => ({ data: mutation.data(), error: mutation.error() }),
        async destroy() {
          await factory.destroy();
          factories.delete(factory);
        },
      };
    },
    async destroy() {
      await Promise.all([...factories].map(factory => factory.destroy()));
      app.destroy();
      await context.scope.destroy();
      afterDestroy();
    },
  };
}
