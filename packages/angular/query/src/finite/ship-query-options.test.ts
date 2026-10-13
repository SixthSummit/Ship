import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EMPTY_RESPONSE_METADATA,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationClient,
  type OperationDefinition,
  type OperationResultOf,
} from '@sixthsummit/ship-angular/operations';
import {
  injectQuery,
  provideTanStackQuery,
  QueryClient,
  QueryObserver,
} from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShipQueryScopeSnapshot } from '../keys/ship-query-key';
import type { ShipReadBinding } from '../keys/ship-read-binding';
import { shipQueryOptions } from './ship-query-options';

type Contract = {
  read: OperationDefinition<{ id: number }, { 200: { title: string } }, 'MISSING'>;
};
type Result = OperationResultOf<Contract, 'read'>;
const binding: ShipReadBinding<Contract, 'read'> = {
  operationId: 'read',
  safety: 'safe',
  inputKey: input => input.id,
  variantKey: 'en',
};
const success = (id = 1, etag?: string): Result => ({
  ok: true,
  status: 200,
  data: { title: `read.${id}` },
  headers: { headers: {}, ...(etag === undefined ? {} : { etag }) },
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture(
  response: (input: { id: number }) => Promise<Result> = async input => success(input.id)
) {
  const queryClient = new QueryClient();
  cleanup.push(() => queryClient.clear());
  const scopeSnapshot = signal<ShipQueryScopeSnapshot>({
    namespace: 'app.v1',
    scopeKey: 'user.a',
    generation: 0,
  });
  const active = signal(true);
  const controller = new AbortController();
  const scope = {
    capture: () => scopeSnapshot(),
    isCurrent: (captured: ShipQueryScopeSnapshot) => active() && captured === scopeSnapshot(),
    signal: (_captured: ShipQueryScopeSnapshot) => controller.signal,
  };
  const call = vi.fn((_id: string, input: { id: number }, _options?: OperationCallOptions) =>
    response(input)
  );
  const client = { call } as unknown as OperationClient<Contract>;
  return { client, call, context: { queryClient, scope }, scopeSnapshot, active, controller };
}

describe('finite query options', () => {
  it('sets conservative defaults and forwards captured call controls', async () => {
    const f = fixture();
    const headers = { locale: 'en' };
    const call = { headers, keepalive: true };
    const options = shipQueryOptions(f.client, binding, { id: 1 }, f.context, { call });
    expect(options).toMatchObject({
      staleTime: 30000,
      gcTime: 300000,
      retry: false,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      enabled: true,
    });
    headers.locale = 'fr';
    call.keepalive = false;
    await f.context.queryClient.fetchQuery(options);
    expect(f.call.mock.calls[0]?.[2]).toMatchObject({ headers: { locale: 'en' }, keepalive: true });
  });
  it.each([
    'queryKey',
    'queryFn',
    'queryKeyHashFn',
    'retry',
    'enabled',
    'initialData',
    'placeholderData',
    'structuralSharing',
    'onSuccess',
  ])('rejects unsafe override %s at runtime', name => {
    const f = fixture();
    expect(() =>
      shipQueryOptions(f.client, binding, { id: 1 }, f.context, { [name]: undefined } as never)
    ).toThrow(TypeError);
  });
  it('rejects symbol overrides', () => {
    const f = fixture();
    expect(() =>
      shipQueryOptions(f.client, binding, { id: 1 }, f.context, {
        [Symbol('unsafe')]: true,
      } as never)
    ).toThrow(TypeError);
  });
  it('accepts freshness and typed display selection', async () => {
    const f = fixture();
    const options = shipQueryOptions(f.client, binding, { id: 1 }, f.context, {
      staleTime: 100,
      gcTime: 200,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
      select: envelope => envelope.data.title,
    });
    const observer = new QueryObserver(f.context.queryClient, options);
    cleanup.push(() => observer.destroy());
    const result = await observer.refetch();
    expect(result.data).toBe('read.1');
    expect(options).toMatchObject({ staleTime: 100, gcTime: 200, refetchOnReconnect: 'always' });
  });
  it('deduplicates simultaneous native observers for the same key', async () => {
    let finish!: (value: Result) => void;
    const f = fixture(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const first = new QueryObserver(
      f.context.queryClient,
      shipQueryOptions(f.client, binding, { id: 1 }, f.context)
    );
    const second = new QueryObserver(
      f.context.queryClient,
      shipQueryOptions(f.client, binding, { id: 1 }, f.context)
    );
    const off1 = first.subscribe(() => {});
    const off2 = second.subscribe(() => {});
    cleanup.push(() => {
      off1();
      off2();
      first.destroy();
      second.destroy();
    });
    expect(f.call).toHaveBeenCalledOnce();
    finish(success());
    await vi.waitFor(() => expect(first.getCurrentResult().data?.data.title).toBe('read.1'));
    expect(second.getCurrentResult().data?.data.title).toBe('read.1');
    expect(f.call).toHaveBeenCalledOnce();
  });
  it('reuses fresh prefetch data and refetches after explicit invalidation', async () => {
    const f = fixture();
    const options = shipQueryOptions(f.client, binding, { id: 1 }, f.context);
    await f.context.queryClient.prefetchQuery(options);
    const observer = new QueryObserver(f.context.queryClient, options);
    const off = observer.subscribe(() => {});
    cleanup.push(() => {
      off();
      observer.destroy();
    });
    expect(observer.getCurrentResult().data?.data.title).toBe('read.1');
    await f.context.queryClient.fetchQuery(options);
    expect(f.call).toHaveBeenCalledOnce();
    await f.context.queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
    expect(f.call).toHaveBeenCalledTimes(2);
  });
  it('refetches stale safe reads on observer mount', async () => {
    const f = fixture();
    const options = shipQueryOptions(f.client, binding, { id: 1 }, f.context, { staleTime: 0 });
    await f.context.queryClient.prefetchQuery(options);
    const observer = new QueryObserver(f.context.queryClient, options);
    const off = observer.subscribe(() => {});
    cleanup.push(() => {
      off();
      observer.destroy();
    });
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
  });
  it('uses the exact key cached envelope for conditional revalidation', async () => {
    let count = 0;
    const f = fixture(async input => {
      count++;
      return count === 2
        ? { ok: true, notModified: true, status: 304, headers: EMPTY_RESPONSE_METADATA }
        : success(input.id, 'v1');
    });
    const options = shipQueryOptions(f.client, binding, { id: 1 }, f.context);
    await f.context.queryClient.fetchQuery(options);
    await f.context.queryClient.invalidateQueries({ queryKey: options.queryKey });
    const result = await f.context.queryClient.fetchQuery(options);
    expect(result.data.title).toBe('read.1');
    expect(result.result.status).toBe(304);
    expect(result.etag).toBe('v1');
    expect(f.call.mock.calls[1]?.[2]?.headers).toEqual({ 'if-none-match': 'v1' });
    await f.context.queryClient.fetchQuery(
      shipQueryOptions(f.client, binding, { id: 2 }, f.context)
    );
    expect(f.call.mock.calls[2]?.[2]?.headers).toEqual({});
  });
  it('forwards native cache cancellation and prevents late cache writes', async () => {
    let finish!: (value: Result) => void;
    const f = fixture(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const options = shipQueryOptions(f.client, binding, { id: 1 }, f.context);
    const task = f.context.queryClient.fetchQuery(options);
    const rejection = expect(task).rejects.toBeDefined();
    await f.context.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
    expect(f.call.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    finish(success());
    await rejection;
    expect(f.context.queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });
  it('leaves retries to the operation policy even if client defaults request retries', async () => {
    const f = fixture(async () => {
      throw new Error('network failure');
    });
    f.context.queryClient.setDefaultOptions({ queries: { retry: 3 } });
    const options = shipQueryOptions(f.client, binding, { id: 1 }, f.context);
    await expect(f.context.queryClient.fetchQuery(options)).rejects.toThrow('network failure');
    expect(f.call).toHaveBeenCalledOnce();
  });
  it('disables undefined input without evaluating its key mapper or calling the client', async () => {
    const f = fixture();
    const inputKey = vi.fn(binding.inputKey);
    const options = shipQueryOptions(f.client, { ...binding, inputKey }, undefined, f.context);
    const observer = new QueryObserver(f.context.queryClient, options);
    const off = observer.subscribe(() => {});
    cleanup.push(() => {
      off();
      observer.destroy();
    });
    expect(options.enabled).toBe(false);
    expect(options.queryKey[6]).toBe('');
    expect(inputKey).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    await expect(f.context.queryClient.fetchQuery(options)).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    expect(f.call).not.toHaveBeenCalled();
  });
  it('disables scope transitions and refuses a stale captured options object', async () => {
    const f = fixture();
    const old = shipQueryOptions(f.client, binding, { id: 1 }, f.context);
    f.active.set(false);
    expect(shipQueryOptions(f.client, binding, { id: 1 }, f.context).enabled).toBe(false);
    await expect(f.context.queryClient.fetchQuery(old)).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    expect(f.call).not.toHaveBeenCalled();
  });
  it('tracks Angular input and scope signals in the native options factory', async () => {
    const f = fixture();
    const input = signal<{ id: number } | undefined>({ id: 1 });
    const factory = computed(() => shipQueryOptions(f.client, binding, input(), f.context));
    const observer = new QueryObserver(f.context.queryClient, factory());
    const off = observer.subscribe(() => {});
    cleanup.push(() => {
      off();
      observer.destroy();
    });
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.data.title).toBe('read.1'));
    input.set({ id: 2 });
    observer.setOptions(factory());
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.data.title).toBe('read.2'));
    f.scopeSnapshot.set({ namespace: 'app.v1', scopeKey: 'user.b', generation: 1 });
    observer.setOptions(factory());
    expect(observer.getCurrentResult().data).toBeUndefined();
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(3));
    input.set(undefined);
    observer.setOptions(factory());
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(f.call).toHaveBeenCalledTimes(3);
  });
  it('inherits owned provider freshness and honors per-query overrides', () => {
    const f = fixture();
    f.context.queryClient.setDefaultOptions({
      queries: {
        staleTime: 8000,
        gcTime: 9000,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: 'always',
        retry: 5,
      },
    });
    expect(shipQueryOptions(f.client, binding, { id: 1 }, f.context)).toMatchObject({
      staleTime: 8000,
      gcTime: 9000,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
      retry: false,
    });
    expect(
      shipQueryOptions(f.client, binding, { id: 1 }, f.context, { staleTime: 2000 })
    ).toMatchObject({ staleTime: 2000, gcTime: 9000 });
  });
  it('updates native injectQuery signals when input and identity change', async () => {
    const f = fixture();
    const input = signal<{ id: number } | undefined>({ id: 1 });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideTanStackQuery(f.context.queryClient)],
    });
    const query = TestBed.runInInjectionContext(() =>
      injectQuery(() => shipQueryOptions(f.client, binding, input(), f.context))
    );
    await vi.waitFor(() => {
      TestBed.tick();
      expect(query.data()?.data.title).toBe('read.1');
    });
    input.set({ id: 2 });
    await vi.waitFor(() => {
      TestBed.tick();
      expect(query.data()?.data.title).toBe('read.2');
    });
    f.scopeSnapshot.set({ namespace: 'app.v1', scopeKey: 'user.b', generation: 1 });
    TestBed.tick();
    expect(query.data()).toBeUndefined();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(f.call).toHaveBeenCalledTimes(3);
    });
    input.set(undefined);
    TestBed.tick();
    expect(query.data()).toBeUndefined();
    expect(f.call).toHaveBeenCalledTimes(3);
  });
  it('blocks inherited cache defaults that could collapse keys or leak placeholder data', async () => {
    const f = fixture();
    f.context.queryClient.setDefaultOptions({
      queries: {
        queryKeyHashFn: () => 'one-key',
        initialData: { secret: true },
        placeholderData: () => ({ secret: true }),
      },
    });
    const first = shipQueryOptions(f.client, binding, { id: 1 }, f.context);
    await f.context.queryClient.fetchQuery(first);
    const next = shipQueryOptions(f.client, binding, { id: 2 }, f.context);
    const observer = new QueryObserver(f.context.queryClient, next);
    cleanup.push(() => observer.destroy());
    expect(observer.getCurrentResult().data).toBeUndefined();
    const result = await f.context.queryClient.fetchQuery(next);
    expect(result.data.title).toBe('read.2');
    expect(f.call).toHaveBeenCalledTimes(2);
  });
});
