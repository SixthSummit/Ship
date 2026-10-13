import { computed } from '@angular/core';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationMutation } from '../../../operations/src/create-operation-mutation';
import type { OperationClient } from '../../../operations/src/operation-client';
import type { OperationDefinition } from '../../../operations/src/operation-contract';
import type { OperationResultOf } from '../../../operations/src/operation-result';
import { EMPTY_RESPONSE_METADATA } from '../../../operations/src/response-metadata';
import { createShipQueryScope } from './create-ship-query-scope';
import type { ShipQueryScopeCache } from './ship-query-scope-config';
import type { ShipQueryScopeSnapshot } from './ship-query-scope-snapshot';

type MutationContract = { edit: OperationDefinition<void, { 200: string }, 'DENIED'> };

function mutationClient(
  call: () => Promise<OperationResultOf<MutationContract, 'edit'>>
): OperationClient<MutationContract> {
  // This fixture implements exactly one operation; the public client preserves generic inference.
  return { call: call as OperationClient<MutationContract>['call'] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function key(scope: ShipQueryScopeSnapshot, mode = 'finite') {
  return [
    'ship-query',
    1,
    scope.namespace,
    scope.scopeKey,
    scope.generation,
    mode,
    'accounts.get',
    'en',
    { id: '1' },
  ] as const;
}

const clients: QueryClient[] = [];
function setup(cacheFactory?: (client: QueryClient) => ShipQueryScopeCache) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const scope = createShipQueryScope({
    namespace: 'app@1',
    scopeKey: 'user-a:tenant-a',
    cache: cacheFactory?.(client) ?? client,
  });
  return { client, scope };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('createShipQueryScope', () => {
  it('tracks immutable snapshots and readiness across every identity replacement', async () => {
    const gate = deferred<void>();
    const { scope } = setup(client => ({
      cancelQueries: () => gate.promise,
      removeQueries: filters => client.removeQueries(filters),
      getMutationCache: () => client.getMutationCache(),
    }));
    const identity = computed(() => scope.capture());
    const active = computed(() => scope.isCurrent(scope.capture()));
    const first = identity();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first)).toEqual(['namespace', 'scopeKey', 'generation']);
    expect(active()).toBe(true);
    const oldSignal = scope.signal(first);
    const change = scope.change(first.scopeKey);
    expect(identity()).toEqual({ ...first, generation: 1 });
    expect(active()).toBe(false);
    expect(oldSignal.aborted).toBe(true);
    expect(scope.signal(identity()).aborted).toBe(true);
    gate.resolve();
    await change;
    expect(active()).toBe(true);
    expect(scope.signal(identity()).aborted).toBe(false);
    for (const scopeKey of ['anonymous', 'user-b:tenant-a', 'user-b:tenant-b']) {
      const previous = scope.capture();
      await scope.change(scopeKey);
      expect(scope.capture().generation).toBe(previous.generation + 1);
      expect(scope.capture().scopeKey).toBe(scopeKey);
      expect(scope.isCurrent(previous)).toBe(false);
    }
  });

  it('removes only matching queries and mutation records, including infinite queries', async () => {
    const { client, scope } = setup();
    const old = scope.capture();
    const keep = [
      ['unrelated'],
      ['ship-query', 2, old.namespace, old.scopeKey, old.generation],
      key({ ...old, namespace: 'other-app' }),
      key({ ...old, scopeKey: 'other-user' }),
      key({ ...old, generation: 42 }),
    ];
    for (const queryKey of [key(old), key(old, 'infinite'), ...keep]) {
      client.setQueryData(queryKey, 'data');
      client.getMutationCache().build(client, { mutationKey: queryKey, gcTime: Infinity });
    }
    const unkeyed = client.getMutationCache().build(client, { gcTime: Infinity });
    const mutation = client.getMutationCache().build(client, {
      mutationKey: [
        'ship-query',
        1,
        old.namespace,
        old.scopeKey,
        old.generation,
        'mutation',
        'edit',
      ],
      gcTime: Infinity,
    });
    await scope.change('user-b');
    expect(client.getQueryData(key(old))).toBeUndefined();
    expect(client.getQueryData(key(old, 'infinite'))).toBeUndefined();
    for (const queryKey of keep) expect(client.getQueryData(queryKey)).toBe('data');
    expect(client.getMutationCache().getAll()).toHaveLength(keep.length + 1);
    expect(client.getMutationCache().getAll()).toContain(unkeyed);
    expect(client.getMutationCache().getAll()).not.toContain(mutation);
  });

  it('stops listeners and mutation work before enabling the new generation', async () => {
    const { scope } = setup();
    const old = scope.capture();
    const events: string[] = [];
    scope.onCleanup(old, () => {
      expect(scope.isCurrent(old)).toBe(false);
      expect(scope.isCurrent(scope.capture())).toBe(false);
      events.push('listener stopped');
    });
    scope.signal(old).addEventListener('abort', () => events.push('signal aborted'));
    scope.registerMutation(old, () => events.push('mutation cancelled'));
    const removed = vi.fn();
    scope.onCleanup(old, removed)();
    scope.registerMutation(old, removed)();
    const next = await scope.change('user-b');
    scope.onCleanup(next, () => undefined);
    events.push('new listener');
    expect(events).toEqual([
      'listener stopped',
      'signal aborted',
      'mutation cancelled',
      'new listener',
    ]);
    expect(removed).not.toHaveBeenCalled();
    const stale = vi.fn();
    scope.onCleanup(old, stale)();
    scope.registerMutation(old, stale)();
    expect(stale).toHaveBeenCalledTimes(2);
    expect(scope.signal(old).aborted).toBe(true);
  });

  it('cannot revive old query data when a non-cooperative request settles late', async () => {
    const { client, scope } = setup();
    const old = scope.capture();
    const response = deferred<string>();
    let requestSignal: AbortSignal | undefined;
    const request = client.fetchQuery({
      queryKey: key(old),
      queryFn: ({ signal }) => {
        requestSignal = signal;
        return response.promise;
      },
    });
    const rejected = request.catch(error => error);
    await scope.change('user-b');
    const next = scope.capture();
    client.setQueryData(key(next), 'new-user data');
    response.resolve('old-user data');
    await rejected;
    await Promise.resolve();
    expect(requestSignal?.aborted).toBe(true);
    expect(client.getQueryData(key(old))).toBeUndefined();
    expect(client.getQueryData(key(next))).toBe('new-user data');
  });

  it('waits for all prior cancellations through rapid transitions', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const cancel = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { scope } = setup(client => ({
      cancelQueries: cancel,
      removeQueries: filters => client.removeQueries(filters),
      getMutationCache: () => client.getMutationCache(),
    }));
    const old = scope.capture();
    const toB = scope.change('b');
    const intermediate = scope.capture();
    const toC = scope.change('c');
    const latest = scope.capture();
    second.resolve();
    await Promise.resolve();
    expect(scope.isCurrent(latest)).toBe(false);
    first.resolve();
    await Promise.all([toB, toC]);
    expect(scope.isCurrent(old)).toBe(false);
    expect(scope.isCurrent(intermediate)).toBe(false);
    expect(scope.isCurrent(latest)).toBe(true);
    expect(latest.generation).toBe(2);
  });

  it('permits a cleanup to request another transition without reviving the outer generation', async () => {
    const { scope } = setup();
    let nested: Promise<ShipQueryScopeSnapshot> | undefined;
    scope.onCleanup(scope.capture(), () => {
      nested = scope.change('c');
    });
    const intermediate = await scope.change('b');
    await nested;
    expect(scope.capture().scopeKey).toBe('c');
    expect(scope.isCurrent(intermediate)).toBe(false);
    expect(scope.isCurrent(scope.capture())).toBe(true);
  });

  it('hides old mutation state immediately without resetting an active executor', async () => {
    const { scope } = setup();
    const old = scope.capture();
    const response = deferred<string>();
    const mutation = createOperationMutation(
      mutationClient(async () => ({
        ok: true,
        status: 200,
        data: await response.promise,
        headers: EMPTY_RESPONSE_METADATA,
      })),
      'edit'
    );
    scope.registerMutation(old, () => mutation.cancel());
    const visible = computed(() => (scope.isCurrent(old) ? mutation.status() : undefined));
    const execution = mutation.execute(undefined).catch(error => error);
    expect(visible()).toBe('pending');
    const changed = scope.change('new');
    expect(visible()).toBeUndefined();
    expect(() => mutation.reset()).toThrow();
    await changed;
    response.resolve('old data');
    await execution;
    expect(visible()).toBeUndefined();
    expect(() => mutation.reset()).not.toThrow();
  });

  it.each(['apply', 'reconcile', 'rollback'] as const)(
    'guards cache effects when scope changes during asynchronous optimistic %s',
    async phase => {
      const { client, scope } = setup();
      const old = scope.capture();
      const started = deferred<void>();
      const resume = deferred<void>();
      const writes = vi.fn();
      const effect = async (currentPhase: string) => {
        if (phase === currentPhase) {
          started.resolve();
          await resume.promise;
        }
        scope.runIfCurrent(old, () => {
          writes();
          client.setQueryData(key(old), currentPhase);
        });
      };
      const operationClient = mutationClient(async () =>
        phase === 'rollback'
          ? {
              ok: false,
              status: 403,
              error: { code: 'DENIED', declared: true, message: 'Denied' },
              headers: EMPTY_RESPONSE_METADATA,
            }
          : { ok: true, status: 200, data: 'old result', headers: EMPTY_RESPONSE_METADATA }
      );
      const mutation = createOperationMutation(operationClient, 'edit', {
        optimistic: {
          apply: async () => {
            await effect('apply');
            return null;
          },
          reconcile: async () => effect('reconcile'),
          rollback: async () => effect('rollback'),
        },
      });
      scope.registerMutation(old, () => mutation.cancel());
      const execution = mutation.execute(undefined).catch(error => error);
      await started.promise;
      await scope.change('new');
      const next = scope.capture();
      client.setQueryData(key(next), 'new data');
      const before = writes.mock.calls.length;
      resume.resolve();
      await execution;
      expect(writes).toHaveBeenCalledTimes(before);
      expect(client.getQueryData(key(old))).toBeUndefined();
      expect(client.getQueryData(key(next))).toBe('new data');
    }
  );

  it('keeps the new generation disabled after cleanup errors and still attempts every cleanup', async () => {
    const { client, scope } = setup();
    const old = scope.capture();
    client.setQueryData(key(old), 'old');
    const signal = scope.signal(old);
    const cancel = vi.fn();
    scope.onCleanup(old, () => {
      throw new Error('listener failed');
    });
    scope.registerMutation(old, () => {
      throw new Error('mutation failed');
    });
    scope.registerMutation(old, cancel);
    await expect(scope.change('new')).rejects.toThrow(AggregateError);
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(client.getQueryData(key(old))).toBeUndefined();
    expect(scope.isCurrent(scope.capture())).toBe(false);
    expect(scope.runIfCurrent(scope.capture(), vi.fn())).toBe(false);
    await scope.change('recovery');
    expect(scope.isCurrent(scope.capture())).toBe(true);
  });

  it('fails closed when cache cancellation rejects, without skipping immediate removal', async () => {
    const error = new Error('cancel failed');
    const { client, scope } = setup(client => ({
      cancelQueries: () => Promise.reject(error),
      removeQueries: filters => client.removeQueries(filters),
      getMutationCache: () => client.getMutationCache(),
    }));
    const old = scope.capture();
    client.setQueryData(key(old), 'old');
    await expect(scope.change('new')).rejects.toThrow(AggregateError);
    expect(client.getQueryData(key(old))).toBeUndefined();
    expect(scope.isCurrent(scope.capture())).toBe(false);
  });

  it('destroys once, waits for outstanding transitions, and never re-enables observers', async () => {
    const gate = deferred<void>();
    const { scope } = setup(client => ({
      cancelQueries: () => gate.promise,
      removeQueries: filters => client.removeQueries(filters),
      getMutationCache: () => client.getMutationCache(),
    }));
    const old = scope.capture();
    const visible = computed(() => (scope.isCurrent(old) ? 'old data' : undefined));
    expect(visible()).toBe('old data');
    const changed = scope.change('new');
    const next = scope.capture();
    const destroyed = scope.destroy();
    expect(scope.destroy()).toBe(destroyed);
    expect(visible()).toBeUndefined();
    expect(() => scope.capture()).toThrow('destroyed');
    gate.resolve();
    await Promise.all([changed, destroyed]);
    expect(scope.isCurrent(next)).toBe(false);
    expect(scope.signal(next).aborted).toBe(true);
    await expect(scope.change('another')).rejects.toThrow('destroyed');
  });

  it('invalidates capture computations on destruction and makes reentrant destroy idempotent', async () => {
    const { scope } = setup();
    const captured = computed(() => scope.capture());
    const old = captured();
    let nested: Promise<void> | undefined;
    scope.onCleanup(old, () => {
      nested = scope.destroy();
    });
    const destruction = scope.destroy();
    expect(nested).toBe(destruction);
    expect(() => captured()).toThrow('destroyed');
    await destruction;
  });

  it('attempts remaining cleanup after synchronous cache exceptions', async () => {
    const removeRecords = vi.fn();
    const { scope } = setup(client => ({
      cancelQueries: () => {
        throw new Error('cancel failed');
      },
      removeQueries: () => {
        throw new Error('remove failed');
      },
      getMutationCache: () => {
        removeRecords();
        return client.getMutationCache();
      },
    }));
    await expect(scope.change('new')).rejects.toThrow(AggregateError);
    expect(removeRecords).toHaveBeenCalledOnce();
    expect(scope.isCurrent(scope.capture())).toBe(false);
  });

  it('rejects invalid identities before altering the live scope and fixes SSR identity', async () => {
    const { client, scope } = setup();
    const old = scope.capture();
    await expect(scope.change('')).rejects.toThrow('scopeKey');
    expect(scope.capture()).toBe(old);
    expect(scope.isCurrent(old)).toBe(true);
    expect(() => createShipQueryScope({ namespace: '', scopeKey: 'a', cache: client })).toThrow(
      'namespace'
    );
    const fixed = createShipQueryScope({
      namespace: 'ssr',
      scopeKey: 'request-a',
      cache: client,
      fixed: true,
    });
    const initial = fixed.capture();
    await expect(fixed.change('request-b')).rejects.toThrow('fixed');
    expect(fixed.isCurrent(initial)).toBe(true);
    await fixed.destroy();
    expect(fixed.isCurrent(initial)).toBe(false);
  });
});
