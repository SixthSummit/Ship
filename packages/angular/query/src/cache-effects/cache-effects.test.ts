import { QueryClient, QueryObserver } from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShipQueryKey } from '../keys/create-ship-query-key';
import type { ShipQueryKey, ShipQueryMode } from '../keys/ship-query-key';
import { createShipQueryScope } from '../scope/create-ship-query-scope';
import { assertShipQueryCacheData } from './assert-ship-query-cache-data';
import { invalidateShipQueries } from './invalidate-ship-queries';
import type { ShipQueryCacheEnvelope } from './ship-query-cache-data';
import { updateShipQueryData } from './update-ship-query-data';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});
const envelope = (data: unknown = 'body'): ShipQueryCacheEnvelope => ({
  data,
  result: { ok: true, status: 200, data, headers: { headers: {} } },
});
function fixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const scope = createShipQueryScope({
    namespace: 'app@1',
    scopeKey: 'user1/tenant1',
    cache: queryClient,
  });
  cleanup.push(() => {
    void scope.destroy();
    queryClient.clear();
  });
  const captured = scope.capture();
  const key = (operationId = 'read', input = 1, mode: ShipQueryMode = 'finite') =>
    createShipQueryKey(
      {
        operationId,
        safety: 'safe',
        inputKey: (i: number) => i,
        variantKey: 'en',
      },
      input,
      captured,
      mode
    );
  return { context: { queryClient, scope }, captured, key };
}

describe('explicit invalidation', () => {
  it('invalidates one exact key and preserves other variants, inputs, modes, and native queries', async () => {
    const f = fixture();
    const selected = f.key();
    const others = [f.key('read', 2), f.key('read', 1, 'infinite'), f.key('other'), ['native']];
    f.context.queryClient.setQueryData(selected, envelope());
    for (const key of others) f.context.queryClient.setQueryData(key, envelope());
    expect(
      await invalidateShipQueries(f.context, [{ kind: 'exact', key: selected }], f.captured)
    ).toBe(true);
    expect(f.context.queryClient.getQueryState(selected)?.isInvalidated).toBe(true);
    for (const key of others)
      expect(f.context.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it('operation targets include finite and infinite reads only in the captured scope', async () => {
    const f = fixture();
    const selected = [f.key(), f.key('read', 2), f.key('read', 1, 'infinite')];
    const prototype = f.key();
    const unrelated = [
      f.key('write'),
      ['native'],
      [...prototype.slice(0, 2), 'other@1', ...prototype.slice(3)],
      [...prototype.slice(0, 3), 'user2/tenant1', ...prototype.slice(4)],
      [...prototype.slice(0, 4), 1, ...prototype.slice(5)],
      [...prototype.slice(0, 5), 'mutation', ...prototype.slice(6)],
      [...prototype.slice(0, 6), '', ...prototype.slice(7)],
      [...prototype.slice(0, 8)],
    ];
    for (const key of [...selected, ...unrelated])
      f.context.queryClient.setQueryData(key, envelope());
    expect(
      await invalidateShipQueries(
        f.context,
        [{ kind: 'operation', operationId: 'read' }],
        f.captured
      )
    ).toBe(true);
    for (const key of selected)
      expect(f.context.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of unrelated)
      expect(f.context.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it('refetches active targets and reports false when the scope changes during settlement', async () => {
    const f = fixture();
    const key = f.key();
    f.context.queryClient.setQueryData(key, envelope('before'));
    let settle!: (value: ShipQueryCacheEnvelope) => void;
    const read = vi.fn(
      () =>
        new Promise<ShipQueryCacheEnvelope>(resolve => {
          settle = resolve;
        })
    );
    const observer = new QueryObserver(f.context.queryClient, {
      queryKey: key,
      queryFn: read,
      staleTime: Infinity,
    });
    const off = observer.subscribe(() => {});
    cleanup.push(() => {
      off();
      observer.destroy();
    });
    const invalidating = invalidateShipQueries(
      f.context,
      [{ kind: 'operation', operationId: 'read' }],
      f.captured
    );
    expect(read).toHaveBeenCalledTimes(1);
    await f.context.scope.change('user2/tenant1');
    settle(envelope('late private data'));
    expect(await invalidating).toBe(false);
    expect(f.context.queryClient.getQueryData(key)).toBeUndefined();
  });

  it('refetches active exact targets and keeps unrelated requests idle', async () => {
    const f = fixture();
    const key = f.key();
    const unrelated = f.key('other');
    f.context.queryClient.setQueryData(key, envelope('before'));
    f.context.queryClient.setQueryData(unrelated, envelope('keep'));
    const read = vi.fn(async () => envelope('after'));
    const other = vi.fn(async () => envelope('unrelated'));
    const first = new QueryObserver(f.context.queryClient, {
      queryKey: key,
      queryFn: read,
      staleTime: Infinity,
    });
    const second = new QueryObserver(f.context.queryClient, {
      queryKey: unrelated,
      queryFn: other,
      staleTime: Infinity,
    });
    const stop1 = first.subscribe(() => {});
    const stop2 = second.subscribe(() => {});
    cleanup.push(() => {
      stop1();
      stop2();
      first.destroy();
      second.destroy();
    });
    expect(await invalidateShipQueries(f.context, [{ kind: 'exact', key }], f.captured)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(f.context.queryClient.getQueryData(key)).toEqual(envelope('after'));
  });

  it('rejects stale snapshots without issuing invalidation and accepts an explicit empty target list', async () => {
    const f = fixture();
    const invalidate = vi.spyOn(f.context.queryClient, 'invalidateQueries');
    expect(await invalidateShipQueries(f.context, [], f.captured)).toBe(true);
    await f.context.scope.change('user2');
    expect(
      await invalidateShipQueries(
        f.context,
        [{ kind: 'operation', operationId: 'read' }],
        f.captured
      )
    ).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    [null],
    [{ kind: 'all' }],
    [{ kind: 'operation', operationId: '' }],
    [{ kind: 'operation', operationId: 1 }],
  ])('rejects invalid targets', async targets => {
    const f = fixture();
    await expect(
      invalidateShipQueries(f.context, targets as never, f.captured)
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('validates every target before performing any invalidation', async () => {
    const f = fixture();
    const key = f.key();
    f.context.queryClient.setQueryData(key, envelope());
    await expect(
      invalidateShipQueries(
        f.context,
        [{ kind: 'exact', key }, { kind: 'all' } as never],
        f.captured
      )
    ).rejects.toBeInstanceOf(TypeError);
    expect(f.context.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it('suppresses effects if target access changes the scope', async () => {
    const f = fixture();
    const changing: Promise<unknown>[] = [];
    const target = {
      kind: 'operation' as const,
      get operationId() {
        changing.push(f.context.scope.change('user2'));
        return 'read';
      },
    };
    expect(await invalidateShipQueries(f.context, [target], f.captured)).toBe(false);
    await Promise.all(changing);
  });
});

describe('guarded cache updates', () => {
  it('updates typed envelopes and aligned infinite pages without touching another key', () => {
    const f = fixture();
    const key = f.key();
    const infinite = f.key('read', 1, 'infinite');
    f.context.queryClient.setQueryData(key, envelope('before'));
    const updated = updateShipQueryData<ShipQueryCacheEnvelope>(
      f.context,
      key,
      previous => ({ ...previous!, data: 'after' }),
      f.captured
    );
    expect(updated?.data).toBe('after');
    const pages = { pages: [envelope('page')], pageParams: [0] };
    expect(updateShipQueryData(f.context, infinite, () => pages, f.captured)).toEqual(pages);
    expect(f.context.queryClient.getQueryData(key)).toEqual(updated);
  });

  it('supports undefined bodies inside envelopes and undefined updater results that skip creation', () => {
    const f = fixture();
    const key = f.key();
    expect(updateShipQueryData(f.context, key, () => undefined, f.captured)).toBeUndefined();
    expect(f.context.queryClient.getQueryState(key)).toBeUndefined();
    const body = {
      data: undefined,
      result: { ok: true as const, status: 204, data: undefined, headers: { headers: {} } },
    };
    expect(updateShipQueryData(f.context, key, () => body, f.captured)).toEqual(body);
  });

  it('does not invoke a late updater or write after an asynchronous scope change', async () => {
    const f = fixture();
    const key = f.key();
    const updater = vi.fn(() => envelope());
    await f.context.scope.change('user2');
    expect(updateShipQueryData(f.context, key, updater, f.captured)).toBeUndefined();
    expect(updater).not.toHaveBeenCalled();
    expect(f.context.queryClient.getQueryState(key)).toBeUndefined();
  });

  it('rechecks the scope after a callback starts a transition and does not recreate the old key', async () => {
    const f = fixture();
    const key = f.key();
    f.context.queryClient.setQueryData(key, envelope('private before'));
    let changing!: Promise<unknown>;
    const value = updateShipQueryData(
      f.context,
      key,
      () => {
        changing = f.context.scope.change('user2');
        return envelope('private late');
      },
      f.captured
    );
    expect(value).toBeUndefined();
    await changing;
    expect(f.context.queryClient.getQueryState(key)).toBeUndefined();
  });

  it('rechecks the scope at completion when a cache listener starts a transition', async () => {
    const f = fixture();
    let changing: Promise<unknown> | undefined;
    const off = f.context.queryClient.getQueryCache().subscribe(event => {
      if (event.type === 'updated') changing = f.context.scope.change('user2');
    });
    const value = updateShipQueryData(f.context, f.key(), () => envelope(), f.captured);
    off();
    expect(value).toBeUndefined();
    await changing;
    expect(f.context.queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('rejects an async updater and invalid data without creating a cache entry', () => {
    const f = fixture();
    const key = f.key();
    expect(() =>
      updateShipQueryData(f.context, key, (async () => envelope()) as never, f.captured)
    ).toThrow(TypeError);
    expect(() =>
      updateShipQueryData(f.context, key, (() => 'primitive') as never, f.captured)
    ).toThrow(TypeError);
    expect(f.context.queryClient.getQueryState(key)).toBeUndefined();
  });

  it('rejects malformed prior cached data before calling the typed updater', () => {
    const f = fixture();
    const key = f.key();
    const updater = vi.fn(() => envelope());
    f.context.queryClient.setQueryData(key, 'wrong');
    expect(() => updateShipQueryData(f.context, key, updater, f.captured)).toThrow(TypeError);
    expect(updater).not.toHaveBeenCalled();
  });

  it('rechecks scope when envelope validation invokes a getter', async () => {
    const f = fixture();
    const key = f.key();
    let changing: Promise<unknown> | undefined;
    const next = {
      data: 'late',
      get result() {
        changing ??= f.context.scope.change('user2');
        return envelope().result;
      },
    };
    expect(updateShipQueryData(f.context, key, () => next, f.captured)).toBeUndefined();
    await changing;
    expect(f.context.queryClient.getQueryState(key)).toBeUndefined();
  });

  it('does not invoke an updater if prior-envelope validation changes scope', async () => {
    const f = fixture();
    const key = f.key();
    let changing: Promise<unknown> | undefined;
    const previous = {
      data: 'private',
      get result() {
        changing ??= f.context.scope.change('user2');
        return envelope().result;
      },
    };
    f.context.queryClient.setQueryData(key, previous);
    const update = vi.fn(() => envelope());
    expect(updateShipQueryData(f.context, key, update, f.captured)).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    await changing;
    expect(f.context.queryClient.getQueryState(key)).toBeUndefined();
  });

  it('checks current scope again immediately before invoking the callback', () => {
    const f = fixture();
    const updater = vi.fn(() => envelope());
    vi.spyOn(f.context.scope, 'isCurrent').mockReturnValueOnce(true).mockReturnValue(false);
    expect(updateShipQueryData(f.context, f.key(), updater, f.captured)).toBeUndefined();
    expect(updater).not.toHaveBeenCalled();
  });

  it.each([
    ['native'],
    ['ship-query', 2, 'app@1', 'user1/tenant1', 0, 'finite', 'read', null, null],
    ['ship-query', 1, 'other@1', 'user1/tenant1', 0, 'finite', 'read', null, null],
    ['ship-query', 1, 'app@1', 'other-user', 0, 'finite', 'read', null, null],
    ['ship-query', 1, 'app@1', 'user1/tenant1', 1, 'finite', 'read', null, null],
    ['ship-query', 1, 'app@1', 'user1/tenant1', 0, 'mutation', 'read', null, null],
    ['ship-query', 1, 'app@1', 'user1/tenant1', 0, 'finite', '', null, null],
    ['ship-query', 1, 'app@1', 'user1/tenant1', 0, 'finite', 'read', undefined, null],
  ])('rejects malformed or foreign exact keys', (...segments) => {
    const f = fixture();
    const key = segments as unknown as ShipQueryKey;
    expect(() => updateShipQueryData(f.context, key, () => envelope(), f.captured)).toThrow(
      TypeError
    );
  });
});

describe('cache envelope shapes', () => {
  it.each([
    null,
    'body',
    { data: 1 },
    { result: envelope().result },
    { data: 1, result: { ok: false, status: 200, headers: {} } },
    { ...envelope(), etag: undefined },
    { data: 1, result: { ok: true, status: 1.5, headers: {} } },
    { data: 1, result: { ok: true, status: 200 } },
    { data: 1, result: { ok: true, status: 200, headers: null } },
    { data: 1, result: { ok: true, status: 199, headers: { headers: {} } } },
    { data: 1, result: { ok: true, status: 500, headers: { headers: {} } } },
    { data: 1, result: { ok: true, status: '200', headers: { headers: {} } } },
    { data: 1, result: { ok: true, status: 200, headers: {} } },
    { data: 1, result: { ok: true, status: 200, headers: { headers: null } } },
  ])('rejects malformed finite envelopes', value => {
    expect(() => assertShipQueryCacheData(value, 'finite')).toThrow(TypeError);
  });

  it.each([
    { pages: [], pageParams: [0] },
    { pages: [] },
    { pages: null, pageParams: [] },
    { pages: ['bad'], pageParams: [0] },
  ])('rejects malformed infinite envelopes', value => {
    expect(() => assertShipQueryCacheData(value, 'infinite')).toThrow(TypeError);
  });

  it('accepts explicit validators and complete successful envelopes', () => {
    expect(() => assertShipQueryCacheData({ ...envelope(), etag: 'v1' }, 'finite')).not.toThrow();
    expect(() =>
      assertShipQueryCacheData(
        {
          data: 'cached',
          result: { ok: true, notModified: true, status: 304, headers: { headers: {} } },
        },
        'finite'
      )
    ).not.toThrow();
  });
});
