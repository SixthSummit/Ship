import '@angular/compiler';
import {
  createEnvironmentInjector,
  type EnvironmentInjector,
  ErrorHandler,
  Injector,
  runInInjectionContext,
} from '@angular/core';
import { injectQueryClient, QueryClient } from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provideShipQuery } from './provide-ship-query';
import { resolveShipQueryFreshness } from './resolve-ship-query-freshness';
import { SHIP_QUERY_CONTEXT } from './ship-query-context-token';

const injectors: EnvironmentInjector[] = [];
const errors: unknown[] = [];
const createParent = () => {
  const parent = createEnvironmentInjector(
    [{ provide: ErrorHandler, useValue: { handleError: (error: unknown) => errors.push(error) } }],
    Injector.NULL as EnvironmentInjector
  );
  injectors.push(parent);
  return parent;
};
const createApp = (scopeKey = 'anonymous', parent = createParent()) => {
  const injector = createEnvironmentInjector(
    [provideShipQuery({ namespace: 'app@1', scopeKey })],
    parent
  );
  injectors.push(injector);
  return injector;
};
afterEach(() => {
  for (const injector of injectors.reverse()) if (!injector.destroyed) injector.destroy();
  injectors.length = 0;
  errors.length = 0;
  vi.restoreAllMocks();
});

describe('owned browser query provider', () => {
  it('provides the same native and Ship client, with explicit defaults', () => {
    const mount = vi.spyOn(QueryClient.prototype, 'mount');
    const injector = createApp();
    const context = injector.get(SHIP_QUERY_CONTEXT);
    expect(injector.get(SHIP_QUERY_CONTEXT)).toBe(context);
    expect(injector.get(QueryClient)).toBe(context.queryClient);
    expect(runInInjectionContext(injector, injectQueryClient)).toBe(context.queryClient);
    expect(context.queryClient.getDefaultOptions()).toEqual({
      queries: {
        staleTime: 30000,
        gcTime: 300000,
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: false,
      },
      mutations: { retry: false },
    });
    expect(context.scope.capture()).toEqual({
      namespace: 'app@1',
      scopeKey: 'anonymous',
      generation: 0,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('creates different clients for two applications and parent-child applications', () => {
    const parent = createParent();
    const first = createApp('user:1', parent);
    const second = createApp('user:2', parent);
    const child = createApp('user:3', first);
    const clients = [first, second, child].map(i => i.get(SHIP_QUERY_CONTEXT).queryClient);
    expect(new Set(clients).size).toBe(3);
    clients[0]?.setQueryData(['example'], 'first');
    expect(clients[1]?.getQueryData(['example'])).toBeUndefined();
    expect(clients[2]?.getQueryData(['example'])).toBeUndefined();
    first.destroy();
    expect(
      second.get(SHIP_QUERY_CONTEXT).scope.isCurrent(second.get(SHIP_QUERY_CONTEXT).scope.capture())
    ).toBe(true);
    expect(
      child.get(SHIP_QUERY_CONTEXT).scope.isCurrent(child.get(SHIP_QUERY_CONTEXT).scope.capture())
    ).toBe(true);
  });

  it('rejects duplicate registration before creating or mounting a client', () => {
    const mount = vi.spyOn(QueryClient.prototype, 'mount');
    const parent = createParent();
    expect(() =>
      createEnvironmentInjector(
        [
          provideShipQuery({ namespace: 'app@1', scopeKey: 'user:1' }),
          provideShipQuery({ namespace: 'app@1', scopeKey: 'user:1' }),
        ],
        parent
      )
    ).toThrow('only once');
    expect(mount).not.toHaveBeenCalled();
  });

  it('rejects an overridden native QueryClient before observers can use another cache', () => {
    const foreign = new QueryClient();
    foreign.setQueryData(['foreign'], 'preserve');
    expect(() =>
      createEnvironmentInjector(
        [
          provideShipQuery({ namespace: 'app@1', scopeKey: 'user:1' }),
          { provide: QueryClient, useValue: foreign },
        ],
        createParent()
      )
    ).toThrow('owned client');
    expect(foreign.getQueryData(['foreign'])).toBe('preserve');
  });

  it('rejects duplicate owned registrations even when native injection is overridden', () => {
    const mount = vi.spyOn(QueryClient.prototype, 'mount');
    expect(() =>
      createEnvironmentInjector(
        [
          provideShipQuery({ namespace: 'app@1', scopeKey: 'user:1' }),
          provideShipQuery({ namespace: 'app@1', scopeKey: 'user:1' }),
          { provide: QueryClient, useValue: new QueryClient() },
        ],
        createParent()
      )
    ).toThrow('only once');
    expect(mount).not.toHaveBeenCalled();
  });

  it('snapshots the provider configuration and applies supported freshness overrides', () => {
    const config = {
      namespace: 'custom@1',
      scopeKey: 'user:1',
      freshness: {
        staleTime: Infinity,
        gcTime: 0,
        refetchOnMount: false,
        refetchOnWindowFocus: 'always' as const,
        refetchOnReconnect: false,
      },
    };
    const providers = provideShipQuery(config);
    config.scopeKey = 'user:2';
    config.freshness.staleTime = 1;
    const injector = createEnvironmentInjector([providers], createParent());
    injectors.push(injector);
    const context = injector.get(SHIP_QUERY_CONTEXT);
    expect(context.scope.capture().scopeKey).toBe('user:1');
    expect(context.queryClient.getDefaultOptions().queries).toMatchObject({
      staleTime: Infinity,
      gcTime: 0,
      refetchOnMount: false,
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: false,
      retry: false,
    });
  });

  it('aborts owned reads, clears query and mutation records, and unmounts on destroy', async () => {
    const injector = createApp('user:1');
    const context = injector.get(SHIP_QUERY_CONTEXT);
    const captured = context.scope.capture();
    const scopeSignal = context.scope.signal(captured);
    const unmount = vi.spyOn(context.queryClient, 'unmount');
    let requestSignal: AbortSignal | undefined;
    const pending = context.queryClient
      .fetchQuery({
        queryKey: ['ship-query', 1, 'app@1', 'user:1', 0, 'finite', 'list', null, null],
        queryFn: ({ signal }) => {
          requestSignal = signal;
          return new Promise<string>(() => {});
        },
      })
      .catch(error => error);
    context.queryClient.setQueryData(['another-owned-query'], 'cached');
    context.queryClient.getMutationCache().build(context.queryClient, { mutationKey: ['example'] });
    injector.destroy();
    expect(requestSignal?.aborted).toBe(true);
    expect(scopeSignal.aborted).toBe(true);
    expect(context.scope.isCurrent(captured)).toBe(false);
    expect(context.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(context.queryClient.getMutationCache().getAll()).toEqual([]);
    expect(unmount).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('keeps an unrelated client intact and disables late writes', async () => {
    const unrelated = new QueryClient();
    unrelated.setQueryData(['unrelated'], 'keep');
    const parent = createEnvironmentInjector(
      [
        { provide: QueryClient, useValue: unrelated },
        {
          provide: ErrorHandler,
          useValue: { handleError: (error: unknown) => errors.push(error) },
        },
      ],
      Injector.NULL as EnvironmentInjector
    );
    injectors.push(parent);
    const injector = createApp('user:1', parent);
    const { scope, queryClient } = injector.get(SHIP_QUERY_CONTEXT);
    const captured = scope.capture();
    injector.destroy();
    expect(scope.runIfCurrent(captured, () => queryClient.setQueryData(['late'], 'wrong'))).toBe(
      false
    );
    expect(queryClient.getQueryData(['late'])).toBeUndefined();
    expect(unrelated.getQueryData(['unrelated'])).toBe('keep');
    await scope.destroy();
  });

  it('reports asynchronous scope cleanup errors without retaining cache data', async () => {
    const injector = createApp();
    const { scope, queryClient } = injector.get(SHIP_QUERY_CONTEXT);
    scope.onCleanup(scope.capture(), () => {
      throw new Error('listener cleanup failed');
    });
    queryClient.setQueryData(['cached'], 'data');
    injector.destroy();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBeInstanceOf(AggregateError);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('does not add retries to failed native reads or mutations', async () => {
    const { queryClient } = createApp().get(SHIP_QUERY_CONTEXT);
    const failure = new Error('expected transport failure');
    const read = vi.fn(() => Promise.reject(failure));
    await expect(queryClient.fetchQuery({ queryKey: ['failed'], queryFn: read })).rejects.toBe(
      failure
    );
    expect(read).toHaveBeenCalledTimes(1);
    const write = vi.fn(() => Promise.reject(failure));
    const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: write });
    await expect(mutation.execute(undefined)).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('provider configuration validation', () => {
  it.each([
    undefined,
    null,
    { namespace: '', scopeKey: 'a' },
    { namespace: 'a', scopeKey: '' },
    { namespace: 1, scopeKey: 'a' },
  ])('rejects invalid identity configuration', config => {
    expect(() => provideShipQuery(config as never)).toThrow(TypeError);
  });

  it.each(['retry', 'queryFn', 'queryKey', 'mutationFn', Symbol('override')])(
    'rejects restricted options even when types are bypassed',
    key => {
      expect(() =>
        provideShipQuery({ namespace: 'app', scopeKey: 'a', freshness: { [key]: false } as never })
      ).toThrow('override');
    }
  );

  it.each([
    null,
    false,
    [],
    'invalid',
    { staleTime: -1 },
    { gcTime: NaN },
    { gcTime: '100' },
    { staleTime: null },
    { refetchOnReconnect: null },
    { refetchOnMount: 'invalid' },
  ])('rejects invalid freshness configuration', freshness => {
    expect(() => resolveShipQueryFreshness(freshness as never)).toThrow(TypeError);
  });
});
