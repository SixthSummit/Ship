import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  OperationClient,
  OperationDefinition,
  OperationResultOf,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provideShipQuery } from '../browser-provider/provide-ship-query';
import { SHIP_QUERY_CONTEXT } from '../browser-provider/ship-query-context-token';
import { injectShipInfiniteQuery } from './inject-ship-infinite-query';
import type { ShipQueryPagination } from './ship-query-pagination';

type Input = { filter: string; cursor?: number };
type Contract = {
  read: OperationDefinition<
    Input,
    { 200: { title: string; next: number | null; cursor: number } },
    'DENIED'
  >;
};
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
const success = (user: string, cursor = 0): Result => ({
  ok: true,
  status: 200,
  data: { title: `SECRET_${user}.${cursor}`, cursor, next: cursor < 1 ? 1 : null },
  headers: { headers: {} },
});
function setup(response?: (input: Input) => Promise<Result>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideShipQuery({ namespace: 'app', scopeKey: 'user1' }),
    ],
  });
  const context = TestBed.inject(SHIP_QUERY_CONTEXT);
  const call = vi.fn(
    (_operation: string, input: Input) =>
      response?.(input) ?? Promise.resolve(success(context.scope.capture().scopeKey, input.cursor))
  );
  const client = { call } as unknown as OperationClient<Contract>;
  return { context, call, client };
}
const flush = () => TestBed.tick();
afterEach(() => TestBed.resetTestingModule());

describe('scoped native infinite query projection', () => {
  it('hides old pages and all outcome flags before effects and after change settles', async () => {
    const f = setup();
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => ({ filter: 'all' }), f.context, pagination)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.pages[0]?.data.title).toBe('SECRET_user1.0');
    });
    expect(query.hasNextPage()).toBe(true);
    expect(query.isSuccess()).toBe(true);
    const changing = f.context.scope.change('user2');
    expect(query.data()).toBeUndefined();
    expect(query.error()).toBeNull();
    expect(query.hasNextPage()).toBe(false);
    expect(query.hasPreviousPage()).toBe(false);
    expect(query.isSuccess()).toBe(false);
    expect(query.isFetched()).toBe(false);
    expect(query.isFetchingNextPage()).toBe(false);
    expect(query.isFetchingPreviousPage()).toBe(false);
    expect(query.isFetchNextPageError()).toBe(false);
    expect(query.isFetchPreviousPageError()).toBe(false);
    expect(query.dataUpdatedAt()).toBe(0);
    expect(query.failureReason()).toBeNull();
    await changing;
    expect(query.data()).toBeUndefined();
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.pages[0]?.data.title).toBe('SECRET_user2.0');
    });
  });
  it('guards primitive selection and tracks reactive options', async () => {
    const f = setup();
    const prefix = signal('first:');
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(
        f.client,
        binding,
        () => ({ filter: 'all' }),
        f.context,
        pagination,
        () => {
          const value = prefix();
          return { select: data => `${value}${data.pages[0]?.data.title}` };
        }
      )
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()).toBe('first:SECRET_user1.0');
    });
    prefix.set('second:');
    await vi.waitFor(() => {
      flush();
      expect(query.data()).toBe('second:SECRET_user1.0');
    });
    const changing = f.context.scope.change('user2');
    expect(query.data()).toBeUndefined();
    await changing;
    expect(query.data()).toBeUndefined();
  });
  it('unwraps original operation and select errors and masks them immediately', async () => {
    const secret = new Error('SECRET_ERROR_user1');
    const f = setup(async () => {
      throw secret;
    });
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => ({ filter: 'all' }), f.context, pagination)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.error()).toBe(secret);
    });
    expect(query.isError()).toBe(true);
    expect(query.failureReason()).toBe(secret);
    const changing = f.context.scope.change('user2');
    expect(query.error()).toBeNull();
    expect(query.errorUpdatedAt()).toBe(0);
    expect(query.failureCount()).toBe(0);
    await changing;
    expect(query.error()).toBeNull();
  });
  it('preserves a custom select error without allowing stale error exposure', async () => {
    const secret = new Error('SECRET_SELECT_user1');
    const f = setup();
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => ({ filter: 'all' }), f.context, pagination, {
        select: () => {
          throw secret;
        },
      })
    );
    await vi.waitFor(() => {
      flush();
      expect(query.error()).toBe(secret);
    });
    await f.context.scope.change('user2');
    expect(query.error()).toBeNull();
  });
  it('shares concurrent next-page requests and stops at end', async () => {
    let finish!: (result: Result) => void;
    const f = setup(input =>
      input.cursor === 1
        ? new Promise(resolve => {
            finish = resolve;
          })
        : Promise.resolve(success('user1'))
    );
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => ({ filter: 'all' }), f.context, pagination)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.pages).toHaveLength(1);
    });
    const first = query.fetchNextPage();
    const second = query.fetchNextPage();
    expect(f.call).toHaveBeenCalledTimes(2);
    finish(success('user1', 1));
    const [one, two] = await Promise.all([first, second]);
    expect(one.data?.pages).toHaveLength(2);
    expect(two.data?.pageParams).toEqual([0, 1]);
    await query.fetchNextPage();
    expect(f.call).toHaveBeenCalledTimes(2);
  });
  it('protects next-page awaited results and pending flags during identity replacement', async () => {
    let finish!: (result: Result) => void;
    const f = setup(input =>
      input.cursor === 1
        ? new Promise(resolve => {
            finish = resolve;
          })
        : Promise.resolve(success('user1'))
    );
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => ({ filter: 'all' }), f.context, pagination)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.pages).toHaveLength(1);
    });
    const next = query.fetchNextPage();
    const rejected = expect(next).rejects.toMatchObject({ name: 'OperationAbortedError' });
    const changing = f.context.scope.change('user2');
    expect(query.data()).toBeUndefined();
    expect(query.isFetchingNextPage()).toBe(false);
    await changing;
    finish(success('user1', 1));
    await rejected;
    expect(query.data()).toBeUndefined();
  });
  it('protects refetch and previous-page awaited results', async () => {
    const f = setup();
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => ({ filter: 'all' }), f.context, {
        ...pagination,
        initialPageParam: 1,
      })
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.pageParams).toEqual([1]);
    });
    const previous = await query.fetchPreviousPage();
    expect(previous.data?.pageParams).toEqual([0, 1]);
    const refreshed = await query.refetch();
    expect(refreshed.data?.pages).toHaveLength(2);
    expect(refreshed.data?.pageParams).toEqual([0, 1]);
  });
  it('preserves original method failures for throwOnError', async () => {
    const state: { error?: Error } = {};
    const f = setup(async input => {
      if (state.error) throw state.error;
      return success('user1', input.cursor);
    });
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => ({ filter: 'all' }), f.context, pagination)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.pages).toHaveLength(1);
    });
    state.error = new Error('original');
    await expect(query.fetchNextPage({ throwOnError: true })).rejects.toBe(state.error);
  });
  it('rejects protected fetch controls and disabled input without transport work', async () => {
    const f = setup();
    const query = TestBed.runInInjectionContext(() =>
      injectShipInfiniteQuery(f.client, binding, () => undefined, f.context, pagination)
    );
    flush();
    await expect(query.fetchNextPage({ cancelRefetch: true } as never)).rejects.toThrow(TypeError);
    await expect(query.fetchPreviousPage()).rejects.toMatchObject({
      name: 'OperationAbortedError',
    });
    await expect(query.refetch()).rejects.toMatchObject({ name: 'OperationAbortedError' });
    expect(f.call).not.toHaveBeenCalled();
    expect(query.data()).toBeUndefined();
  });
});
