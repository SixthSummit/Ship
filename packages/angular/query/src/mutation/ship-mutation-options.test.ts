import {
  OperationAbortedError,
  OperationApiError,
  type OperationCallOptions,
  type OperationClient,
  type OperationDefinition,
  OperationMutationBusyError,
  OperationMutationRollbackError,
  type OperationResultOf,
  ProtocolError,
} from '@sixthsummit/ship-angular/operations';
import { MutationObserver, QueryClient } from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShipQueryScope } from '../scope/create-ship-query-scope';
import type { ShipMutationConfig } from './ship-mutation-config';
import { shipMutationOptions } from './ship-mutation-options';

type Contract = {
  edit: OperationDefinition<{ name: string }, { 200: string; 204: undefined }, 'DENIED'>;
};
type Input = { name: string };
type Result = OperationResultOf<Contract, 'edit'>;
const clients: QueryClient[] = [];
const definitions: Array<{ destroy(): Promise<void> }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function success(data = 'saved'): Result {
  return {
    ok: true,
    status: 200,
    data,
    headers: { headers: { etag: 'v1' }, etag: 'v1', requestId: 'request-1' },
  };
}
function failure(): Result {
  return {
    ok: false,
    status: 403,
    headers: { headers: { 'x-request-id': 'request-1' }, requestId: 'request-1' },
    error: {
      code: 'DENIED',
      declared: true,
      message: 'Denied',
      details: { reason: 'policy' },
      extensions: { hint: 'retained' },
      envelopeExtensions: { version: 2 },
    },
  };
}
function setup<S = never>(
  handler: (input: Input, options?: OperationCallOptions) => Promise<Result>,
  config: ShipMutationConfig<Contract, 'edit', S> = {}
) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  clients.push(queryClient);
  const scope = createShipQueryScope({
    namespace: 'app@1',
    scopeKey: 'user-a',
    cache: queryClient,
  });
  const context = { scope, queryClient };
  const client: OperationClient<Contract> = {
    call: ((_operation, input, options) =>
      handler(input, options)) as OperationClient<Contract>['call'],
  };
  const factory = shipMutationOptions(client, 'edit', context, config);
  definitions.push(factory);
  const observer = new MutationObserver(queryClient, factory());
  return { queryClient, scope, context, factory, observer };
}
afterEach(async () => {
  await Promise.all(definitions.splice(0).map(definition => definition.destroy()));
  for (const client of clients.splice(0)) client.clear();
});

describe('shipMutationOptions', () => {
  it('adapts successful results and all call controls without adding retries', async () => {
    const call = vi.fn(async () => success());
    const headers = { locale: 'en' };
    const source = new AbortController();
    const { observer, factory } = setup(call, {
      call: {
        headers,
        signal: source.signal,
        idempotencyKey: 'key',
        timeoutMs: 1000,
        keepalive: true,
      },
      gcTime: 0,
    });
    headers.locale = 'changed';
    expect(factory()).toMatchObject({ retry: false, networkMode: 'always', gcTime: 0 });
    const result = await observer.mutate({ name: 'a' });
    expect(result).toEqual({ data: 'saved', result: success(), etag: 'v1' });
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      { name: 'a' },
      expect.objectContaining({
        headers: { locale: 'en' },
        idempotencyKey: 'key',
        timeoutMs: 1000,
        keepalive: true,
        signal: expect.any(AbortSignal),
      })
    );
    expect(observer.getCurrentResult().status).toBe('success');
    expect(factory.cancel()).toBe(false);
  });

  it('retains metadata, typed failure details, and additive fields in native error state', async () => {
    const call = vi.fn(async () => failure());
    const onSuccess = vi.fn();
    const { observer } = setup(call, { onSuccess });
    await expect(observer.mutate({ name: 'a' })).rejects.toMatchObject({
      name: 'OperationApiError',
      code: 'DENIED',
      status: 403,
      requestId: 'request-1',
      details: { reason: 'policy' },
      error: { extensions: { hint: 'retained' }, envelopeExtensions: { version: 2 } },
    });
    expect(observer.getCurrentResult().error).toBeInstanceOf(OperationApiError);
    expect(observer.getCurrentResult().error).toMatchObject({ headers: failure().headers });
    expect(call).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('keeps exceptional errors intact and rejects invalid 304 mutation results', async () => {
    const original = new Error('transport failed');
    const one = setup(async () => {
      throw original;
    });
    await expect(one.observer.mutate({ name: 'a' })).rejects.toBe(original);
    const two = setup(async () => ({
      ok: true,
      status: 304,
      notModified: true,
      headers: { headers: {} },
    }));
    await expect(two.observer.mutate({ name: 'a' })).rejects.toBeInstanceOf(ProtocolError);
    const three = setup(async () => ({
      ok: true,
      status: 204,
      data: undefined,
      headers: { headers: {} },
    }));
    await expect(three.observer.mutate({ name: 'a' })).resolves.toEqual({
      data: undefined,
      result: { ok: true, status: 204, data: undefined, headers: { headers: {} } },
    });
  });

  it('shares one executor across repeated factory reads and observers, rejecting overlaps', async () => {
    const response = deferred<Result>();
    const onSuccess = vi.fn();
    const call = vi.fn(() => response.promise);
    const { observer, factory, queryClient } = setup(call, { onSuccess });
    const first = observer.mutate({ name: 'first' });
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    const secondObserver = new MutationObserver(queryClient, factory());
    factory();
    factory();
    await expect(secondObserver.mutate({ name: 'second' })).rejects.toBeInstanceOf(
      OperationMutationBusyError
    );
    response.resolve(success('first'));
    await expect(first).resolves.toMatchObject({ data: 'first' });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('uses take-latest cancellation and suppresses effects from the first call', async () => {
    const first = deferred<Result>();
    const seen: AbortSignal[] = [];
    const effects: string[] = [];
    const { observer, factory } = setup(
      async (input, options) => {
        seen.push(options!.signal!);
        return input.name === 'first' ? first.promise : success('second');
      },
      {
        concurrency: 'take-latest',
        onSuccess: (envelope, _input, effect) => {
          effect.run(() => effects.push(envelope.data!));
        },
      }
    );
    const old = observer.mutate({ name: 'first' }).catch(error => error);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    observer.setOptions(factory());
    await expect(observer.mutate({ name: 'second' })).resolves.toMatchObject({ data: 'second' });
    expect(await old).toBeInstanceOf(OperationAbortedError);
    expect(seen[0]?.aborted).toBe(true);
    first.resolve(success('first'));
    await Promise.resolve();
    expect(effects).toEqual(['second']);
  });

  it('rejects take-latest optimism and protects configured policy from native overrides', () => {
    expect(() =>
      setup(async () => success(), {
        concurrency: 'take-latest',
        optimistic: { apply: () => null, rollback: () => undefined },
      })
    ).toThrow('take-latest');
    for (const key of [
      'retry',
      'mutationFn',
      'mutationKey',
      'onMutate',
      'onError',
      'networkMode',
      'scope',
      Symbol('override'),
    ]) {
      expect(() => setup(async () => success(), { [key]: true } as never)).toThrow('override');
    }
    for (const config of [
      null,
      [],
      { concurrency: 'parallel' },
      { gcTime: -1 },
      { gcTime: NaN },
      { onSuccess: true },
      { optimistic: {} },
    ]) {
      expect(() => setup(async () => success(), config as never)).toThrow(TypeError);
    }
  });

  it('take-latest retires an awaiting success effect and suppresses its late write', async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const writes: string[] = [];
    const { observer } = setup(async input => success(input.name), {
      concurrency: 'take-latest',
      onSuccess: async (envelope, input, effects) => {
        if (input.name === 'old') {
          entered.resolve();
          await resume.promise;
        }
        effects.run(() => writes.push(envelope.data!));
      },
    });
    const old = observer.mutate({ name: 'old' }).catch(error => error);
    await entered.promise;
    await observer.mutate({ name: 'new' });
    expect(await old).toBeInstanceOf(OperationAbortedError);
    resume.resolve();
    await Promise.resolve();
    expect(writes).toEqual(['new']);
  });

  it('runs one optimism lifecycle and does not inherit QueryClient onMutate defaults', async () => {
    const phases: string[] = [];
    const { observer, factory, queryClient } = setup(async () => success(), {
      optimistic: {
        apply: input => {
          phases.push(`apply:${input.name}`);
          return 'snapshot';
        },
        rollback: () => {
          phases.push('rollback');
        },
        reconcile: (snapshot, data) => {
          phases.push(`reconcile:${snapshot}:${data}`);
        },
      },
      onSuccess: () => {
        phases.push('success');
      },
    });
    queryClient.setMutationDefaults(['ship-query'], {
      onMutate: () => {
        phases.push('native apply');
      },
    });
    observer.setOptions(factory());
    await observer.mutate({ name: 'a' });
    expect(phases).toEqual(['apply:a', 'reconcile:snapshot:saved', 'success']);
  });

  it('rolls back once and retains both original failure and rollback error', async () => {
    const rollbackError = new Error('rollback failed');
    const rollback = vi.fn(() => {
      throw rollbackError;
    });
    const { observer } = setup(async () => failure(), {
      optimistic: { apply: () => 'before', rollback },
    });
    const error = await observer.mutate({ name: 'a' }).catch(value => value);
    expect(error).toBeInstanceOf(OperationMutationRollbackError);
    expect(error.operationError).toBeInstanceOf(OperationApiError);
    expect(error.operationError.status).toBe(403);
    expect(error.rollbackError).toBe(rollbackError);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('performs rollback for same-scope cancellation and preserves combined cancellation failure', async () => {
    const call = vi.fn(() => new Promise<Result>(() => {}));
    const rollbackError = new Error('rollback failed');
    const rollback = vi.fn(() => {
      throw rollbackError;
    });
    const { observer, factory } = setup(call, { optimistic: { apply: () => 'old', rollback } });
    const pending = observer.mutate({ name: 'a' }).catch(error => error);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(factory.cancel()).toBe(true);
    const error = await pending;
    expect(error).toBeInstanceOf(OperationMutationRollbackError);
    expect(error.operationError).toBeInstanceOf(OperationAbortedError);
    expect(error.rollbackError).toBe(rollbackError);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it.each(['apply', 'reconcile', 'rollback', 'success'] as const)(
    'guards late asynchronous %s effects and allows new-scope work',
    async phase => {
      const entered = deferred<void>();
      const gate = deferred<void>();
      const effects: string[] = [];
      const callback = async (
        name: string,
        guard: { scope: { scopeKey: string }; run(effect: () => void): boolean }
      ) => {
        if (name === phase && guard.scope.scopeKey === 'user-a') {
          entered.resolve();
          await gate.promise;
        }
        guard.run(() => effects.push(`${guard.scope.scopeKey}:${name}`));
      };
      const { observer, factory, scope } = setup(
        async input => (input.name === 'bad' ? failure() : success(input.name)),
        {
          optimistic: {
            apply: async (_input, effect) => {
              await callback('apply', effect);
              return 'snapshot';
            },
            rollback: async (_snapshot, _outcome, effect) => callback('rollback', effect),
            reconcile: async (_snapshot, _data, effect) => callback('reconcile', effect),
          },
          onSuccess: async (_data, _input, effect) => callback('success', effect),
        }
      );
      const old = observer
        .mutate({ name: phase === 'rollback' ? 'bad' : 'old' })
        .catch(error => error);
      await entered.promise;
      await scope.change('user-b');
      const before = effects.filter(value => value.startsWith('user-a')).length;
      observer.setOptions(factory());
      await expect(observer.mutate({ name: 'new' })).resolves.toMatchObject({ data: 'new' });
      expect(await old).toBeInstanceOf(OperationAbortedError);
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(effects.filter(value => value.startsWith('user-a'))).toHaveLength(before);
      expect(effects).toContain('user-b:success');
    }
  );

  it('rejects stale factory options and uses new generation keys without waiting for non-cooperative IO', async () => {
    const first = deferred<Result>();
    const call = vi.fn(async input => (input.name === 'old' ? first.promise : success('new')));
    const { observer, factory, scope, queryClient } = setup(call);
    const staleOptions = factory();
    const old = observer.mutate({ name: 'old' }).catch(error => error);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    await scope.change('user-b');
    const stale = new MutationObserver(queryClient, staleOptions);
    await expect(stale.mutate({ name: 'stale' })).rejects.toBeInstanceOf(OperationAbortedError);
    observer.setOptions(factory());
    expect(observer.options.mutationKey).toEqual([
      'ship-query',
      1,
      'app@1',
      'user-b',
      1,
      'mutation',
      'edit',
    ]);
    await expect(observer.mutate({ name: 'new' })).resolves.toMatchObject({ data: 'new' });
    expect(await old).toBeInstanceOf(OperationAbortedError);
    first.reject(new Error('late failure is handled'));
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('cancels a pre-aborted call before optimism or client work', async () => {
    const source = new AbortController();
    source.abort();
    const call = vi.fn(async () => success());
    const apply = vi.fn(() => null);
    const { observer } = setup(call, {
      call: () => ({ signal: source.signal }),
      optimistic: { apply, rollback: () => undefined },
    });
    await expect(observer.mutate({ name: 'a' })).rejects.toBeInstanceOf(OperationAbortedError);
    expect(call).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('destroys during asynchronous apply without waiting for the application callback', async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const writes = vi.fn();
    const { observer, factory } = setup(async () => success(), {
      optimistic: {
        apply: async (_input, effect) => {
          entered.resolve();
          await gate.promise;
          effect.run(writes);
          return null;
        },
        rollback: () => undefined,
      },
    });
    const pending = observer.mutate({ name: 'a' }).catch(error => error);
    await entered.promise;
    await factory.destroy();
    expect(await pending).toBeInstanceOf(OperationAbortedError);
    gate.resolve();
    await Promise.resolve();
    expect(writes).not.toHaveBeenCalled();
    await expect(observer.mutate({ name: 'again' })).rejects.toBeInstanceOf(OperationAbortedError);
  });
});
