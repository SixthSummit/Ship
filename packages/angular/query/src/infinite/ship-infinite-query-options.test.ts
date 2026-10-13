import {
  type OperationCallOptions,
  type OperationClient,
  type OperationDefinition,
  type OperationResultOf,
} from '@sixthsummit/ship-angular/operations';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shipQueryOptions } from '../finite/ship-query-options';
import type { ShipQueryScopeSnapshot } from '../keys/ship-query-key';
import { shipInfiniteQueryOptions } from './ship-infinite-query-options';
import type { ShipQueryPagination } from './ship-query-pagination';

type Input = { filter: string; cursor?: number };
type Page = { cursor: number; next: number | null; title: string };
type Contract = { read: OperationDefinition<Input, { 200: Page }, 'DENIED'> };
type Result = OperationResultOf<Contract, 'read'>;
const binding = {
  operationId: 'read',
  safety: 'safe',
  inputKey: (input: Input) => input.filter,
  variantKey: null,
} as const;
const pagination: ShipQueryPagination<Contract, 'read', number> = {
  initialPageParam: 0,
  buildInput: (input, cursor) => ({ ...input, cursor }),
  getNextPageParam: last => last.data.next,
  getPreviousPageParam: first => (first.data.cursor > 0 ? first.data.cursor - 1 : null),
};
const success = (cursor: number): Result => ({
  ok: true,
  status: 200,
  data: { cursor, next: cursor < 2 ? cursor + 1 : null, title: `page.${cursor}` },
  headers: { headers: {}, etag: `v${cursor}` },
});
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup(
  response: (input: Input) => Promise<Result> = async input => success(input.cursor ?? 0)
) {
  const queryClient = new QueryClient();
  cleanups.push(() => queryClient.clear());
  const scope: ShipQueryScopeSnapshot = { namespace: 'app', scopeKey: 'a', generation: 0 };
  const controller = new AbortController();
  let current = true;
  const call = vi.fn((_id: string, input: Input, _options?: OperationCallOptions) =>
    response(input)
  );
  const client = { call } as unknown as OperationClient<Contract>;
  const context = {
    queryClient,
    scope: {
      capture: () => scope,
      isCurrent: (_captured: ShipQueryScopeSnapshot) => current,
      signal: (_captured: ShipQueryScopeSnapshot) => controller.signal,
    },
  };
  return {
    client,
    call,
    context,
    expire() {
      current = false;
      controller.abort();
    },
  };
}
function observe(f: ReturnType<typeof setup>, page = pagination) {
  const options = shipInfiniteQueryOptions(f.client, binding, { filter: 'all' }, f.context, page);
  const observer = new InfiniteQueryObserver(f.context.queryClient, options);
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(() => {
    unsubscribe();
    observer.destroy();
  });
  return { options, observer };
}

describe('infinite operation options', () => {
  it('uses defaults and provider freshness, separates finite keys, and includes the initial cursor', () => {
    const f = setup();
    const options = shipInfiniteQueryOptions(
      f.client,
      binding,
      { filter: 'all' },
      f.context,
      pagination
    );
    expect(options).toMatchObject({
      staleTime: 30000,
      gcTime: 300000,
      retry: false,
      initialPageParam: 0,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
    expect(options.queryKey[5]).toBe('infinite');
    expect(options.queryKey[8]).toEqual({ input: 'all', initialPageParam: 0 });
    const other = shipInfiniteQueryOptions(f.client, binding, { filter: 'all' }, f.context, {
      ...pagination,
      initialPageParam: 1,
    });
    expect(options.queryKey).not.toEqual(other.queryKey);
    expect(options.queryKey).not.toEqual(
      shipQueryOptions(f.client, binding, { filter: 'all' }, f.context).queryKey
    );
    f.context.queryClient.setDefaultOptions({
      queries: {
        staleTime: 10,
        gcTime: 20,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: 'always',
      },
    });
    expect(
      shipInfiniteQueryOptions(f.client, binding, { filter: 'all' }, f.context, pagination, {
        gcTime: 40,
      })
    ).toMatchObject({
      staleTime: 10,
      gcTime: 40,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    });
  });
  it('keeps pages and pageParams aligned and stops at the declared end cursor', async () => {
    const f = setup();
    const { observer } = observe(f);
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages).toHaveLength(1));
    await observer.fetchNextPage({ cancelRefetch: false });
    await observer.fetchNextPage({ cancelRefetch: false });
    const result = observer.getCurrentResult();
    expect(result.data?.pages.map(page => page.data.cursor)).toEqual([0, 1, 2]);
    expect(result.data?.pageParams).toEqual([0, 1, 2]);
    expect(result.hasNextPage).toBe(false);
    await observer.fetchNextPage({ cancelRefetch: false });
    expect(f.call).toHaveBeenCalledTimes(3);
  });
  it('supports explicit previous-page cursors', async () => {
    const f = setup();
    const { observer } = observe(f, { ...pagination, initialPageParam: 1 });
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages).toHaveLength(1));
    await observer.fetchPreviousPage({ cancelRefetch: false });
    expect(observer.getCurrentResult().data?.pageParams).toEqual([0, 1]);
    expect(observer.getCurrentResult().hasPreviousPage).toBe(false);
  });
  it('supports a null initial cursor and absence of backward pagination', async () => {
    const f = setup();
    const page: ShipQueryPagination<Contract, 'read', number | null> = {
      initialPageParam: null,
      getNextPageParam: last => last.data.next,
      buildInput: (input, cursor) => ({ ...input, cursor: cursor ?? 0 }),
    };
    const options = shipInfiniteQueryOptions(f.client, binding, { filter: 'all' }, f.context, page);
    const result = await f.context.queryClient.fetchInfiniteQuery(options);
    expect(result.pageParams).toEqual([null]);
    expect(result.pages[0]?.data.cursor).toBe(0);
  });
  it('reuses a native in-flight next-page request', async () => {
    let finish!: (result: Result) => void;
    const f = setup(input =>
      input.cursor === 1
        ? new Promise(resolve => {
            finish = resolve;
          })
        : Promise.resolve(success(0))
    );
    const { observer } = observe(f);
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages).toHaveLength(1));
    const first = observer.fetchNextPage({ cancelRefetch: false });
    const second = observer.fetchNextPage({ cancelRefetch: false });
    expect(f.call).toHaveBeenCalledTimes(2);
    finish(success(1));
    await Promise.all([first, second]);
    expect(observer.getCurrentResult().data?.pageParams).toEqual([0, 1]);
  });
  it('disables conditional revalidation on each page and forwards captured call controls', async () => {
    const f = setup();
    const headers = { locale: 'en', 'If-None-Match': 'wrong' };
    const options = shipInfiniteQueryOptions(
      f.client,
      binding,
      { filter: 'all' },
      f.context,
      pagination,
      { call: { headers, keepalive: true, timeoutMs: 20, idempotencyKey: 'k' } }
    );
    headers.locale = 'fr';
    await f.context.queryClient.fetchInfiniteQuery(options);
    await f.context.queryClient.invalidateQueries({ queryKey: options.queryKey });
    await f.context.queryClient.fetchInfiniteQuery(options);
    for (const call of f.call.mock.calls)
      expect(call[2]).toMatchObject({
        headers: { locale: 'en' },
        keepalive: true,
        timeoutMs: 20,
        idempotencyKey: 'k',
      });
  });
  it('uses a single cache owner for infinite prefetch', async () => {
    const f = setup();
    const options = shipInfiniteQueryOptions(
      f.client,
      binding,
      { filter: 'all' },
      f.context,
      pagination
    );
    await f.context.queryClient.prefetchInfiniteQuery(options);
    await f.context.queryClient.fetchInfiniteQuery(options);
    expect(f.call).toHaveBeenCalledOnce();
  });
  it('disables undefined input without calling the application key mapper or transport', async () => {
    const f = setup();
    const inputKey = vi.fn(binding.inputKey);
    const options = shipInfiniteQueryOptions(
      f.client,
      { ...binding, inputKey },
      undefined,
      f.context,
      pagination
    );
    expect(options.enabled).toBe(false);
    expect(options.queryKey[6]).toBe('');
    expect(inputKey).not.toHaveBeenCalled();
    await expect(f.context.queryClient.fetchInfiniteQuery(options)).rejects.toMatchObject({
      name: 'OperationAbortedError',
    });
    expect(f.call).not.toHaveBeenCalled();
  });
  it('forwards cancellation and suppresses a late page after a scope change', async () => {
    let finish!: (result: Result) => void;
    const f = setup(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const options = shipInfiniteQueryOptions(
      f.client,
      binding,
      { filter: 'all' },
      f.context,
      pagination
    );
    const task = f.context.queryClient.fetchInfiniteQuery(options);
    const rejected = expect(task).rejects.toMatchObject({ name: 'OperationAbortedError' });
    f.expire();
    expect(f.call.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    finish(success(0));
    await rejected;
    expect(f.context.queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });
  it.each([
    'retry',
    'queryFn',
    'queryKey',
    'queryKeyHashFn',
    'initialPageParam',
    'getNextPageParam',
    'getPreviousPageParam',
    'initialData',
    'placeholderData',
    Symbol('unsafe'),
  ])('rejects protected override %s', name => {
    const f = setup();
    expect(() =>
      shipInfiniteQueryOptions(f.client, binding, { filter: 'all' }, f.context, pagination, {
        [name]: undefined,
      } as never)
    ).toThrow(TypeError);
  });
  it.each([
    undefined,
    {},
    { ...pagination, initialPageParam: undefined },
    { ...pagination, buildInput: undefined },
    { ...pagination, getNextPageParam: undefined },
    { ...pagination, getPreviousPageParam: false },
  ])('requires complete pagination and JSON-compatible initial cursors', page => {
    const f = setup();
    expect(() =>
      shipInfiniteQueryOptions(f.client, binding, { filter: 'all' }, f.context, page as never)
    ).toThrow(TypeError);
  });
  it('retains typed operation failures and does not add retries', async () => {
    const f = setup(async () => ({
      ok: false,
      status: 403,
      error: { declared: true, code: 'DENIED', message: 'denied' },
      headers: { headers: {} },
    }));
    await expect(
      f.context.queryClient.fetchInfiniteQuery(
        shipInfiniteQueryOptions(f.client, binding, { filter: 'all' }, f.context, pagination)
      )
    ).rejects.toMatchObject({ name: 'OperationApiError', code: 'DENIED', status: 403 });
    expect(f.call).toHaveBeenCalledOnce();
  });
});
