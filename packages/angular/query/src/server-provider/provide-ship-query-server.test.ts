import '@angular/compiler';
import {
  ApplicationRef,
  createEnvironmentInjector,
  EnvironmentInjector,
  ErrorHandler,
  InjectionToken,
  PendingTasks,
  PLATFORM_ID,
  provideZonelessChangeDetection,
  REQUEST,
  runInInjectionContext,
  TransferState,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { injectQueryClient, QueryClient } from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationRequestPolicy,
  type OperationRequestPolicy,
} from '../../../operations/src/create-operation-request-policy';
import { createPolicyClientFromPolicy } from '../../../operations/src/create-policy-client';
import { OperationApiError } from '../../../operations/src/operation-api-error';
import type {
  OperationExecutionOptions,
  OperationExecutor,
} from '../../../operations/src/operation-client';
import type { OperationDefinition } from '../../../operations/src/operation-contract';
import type { OperationResultOf } from '../../../operations/src/operation-result';
import { EMPTY_RESPONSE_METADATA } from '../../../operations/src/response-metadata';
import type { ShipClientContext } from '../../../operations/src/ship-client-context';
import { createShipClientToken } from '../../../operations/src/ship-client-token';
import { provideShipOperationBoundary } from '../../../operations/src/ship-operation-boundary';
import { provideShipQuery } from '../browser-provider/provide-ship-query';
import { SHIP_QUERY_CONTEXT } from '../browser-provider/ship-query-context-token';
import { provideShipQueryServer } from './provide-ship-query-server';

type Contract = { 'account.get': OperationDefinition<void, { 200: string }, 'UNAVAILABLE'> };
type Result = OperationResultOf<Contract, 'account.get'>;
const CLIENT = createShipClientToken<Contract>('ServerQueryTestClient');
const POLICY = new InjectionToken<OperationRequestPolicy<Contract>>('ServerQueryTestPolicy');
const injectors: EnvironmentInjector[] = [];
const handledErrors: unknown[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function success(value: string): Result {
  return { ok: true, status: 200, data: value, headers: EMPTY_RESPONSE_METADATA };
}

function failure(): Result {
  return {
    ok: false,
    status: 503,
    error: { code: 'UNAVAILABLE', declared: true, message: 'Unavailable' },
    headers: EMPTY_RESPONSE_METADATA,
  };
}

function parentInjector() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: ErrorHandler,
        useValue: { handleError: (error: unknown) => handledErrors.push(error) },
      },
    ],
  });
  return TestBed.inject(EnvironmentInjector);
}

function requestInjector(
  parent: EnvironmentInjector,
  user: string,
  handler: (options: OperationExecutionOptions, context: ShipClientContext) => Promise<Result>,
  options: {
    controller?: AbortController;
    trackPendingTasks?: boolean;
    retry?: boolean;
    delay?: () => Promise<void>;
  } = {}
) {
  const request = new Request('https://site.example.test/account', {
    headers: {
      cookie: `session=${user}; private=do-not-forward`,
      authorization: 'do-not-forward',
      'x-request-id': `request-${user}`,
    },
    ...(options.controller === undefined ? {} : { signal: options.controller.signal }),
  });
  const injector = createEnvironmentInjector(
    [
      { provide: PLATFORM_ID, useValue: 'server' },
      { provide: REQUEST, useValue: request },
      ...provideShipOperationBoundary(
        CLIENT,
        POLICY,
        context => {
          const policy = createOperationRequestPolicy<Contract>({
            policies: {
              'account.get': {
                authentication: 'required',
                safety: 'safe',
                idempotency: 'unsupported',
                replayable: true,
                ...(options.retry ? { retry: { maxAttempts: 2, statuses: [503] } } : {}),
              },
            },
            credentials: { kind: 'cookie' },
            baseHeaders: context.forwardedHeaders,
          });
          const executor: OperationExecutor<Contract> = {
            call: ((_operation, _input, callOptions) =>
              handler(callOptions, context)) as OperationExecutor<Contract>['call'],
          };
          return {
            client: createPolicyClientFromPolicy(executor, policy, {
              ...(context.signal === undefined ? {} : { signal: context.signal }),
              ...(options.delay === undefined ? {} : { delay: options.delay }),
            }),
            requestPolicy: policy,
          };
        },
        {
          apiBaseUrl: 'https://api.example.test/v1',
          forwarding: { cookieNames: ['session'], headerNames: ['x-request-id'] },
          ...(options.trackPendingTasks === undefined
            ? {}
            : { trackPendingTasks: options.trackPendingTasks }),
        }
      ),
      provideShipQueryServer({ namespace: 'app@1', scopeKey: user }),
    ],
    parent
  );
  injectors.push(injector);
  return injector;
}

/** Controlled read port. The real read-options module replaces this at package integration. */
function read(injector: EnvironmentInjector) {
  const context = injector.get(SHIP_QUERY_CONTEXT);
  const snapshot = context.scope.capture();
  const client = injector.get(CLIENT);
  return context.queryClient.fetchQuery({
    queryKey: [
      'ship-query',
      1,
      snapshot.namespace,
      snapshot.scopeKey,
      snapshot.generation,
      'finite',
      'account.get',
      null,
      null,
    ],
    queryFn: async ({ signal }) => {
      const result = await client.call('account.get', undefined, { signal });
      if (!result.ok) throw new OperationApiError(result);
      return result;
    },
  });
}

afterEach(() => {
  for (const injector of injectors.splice(0).reverse()) {
    if (!injector.destroyed) injector.destroy();
  }
  handledErrors.length = 0;
  vi.restoreAllMocks();
});

describe('provideShipQueryServer', () => {
  it('isolates overlapping requests and passes only allowlisted operation context', async () => {
    const parent = parentInjector();
    const first = deferred<Result>();
    const second = deferred<Result>();
    const seen: ShipClientContext[] = [];
    const a = requestInjector(parent, 'user-a', async (options, context) => {
      seen.push(context);
      expect(options.headers).toEqual({
        cookie: 'session=user-a',
        'x-request-id': 'request-user-a',
      });
      return first.promise;
    });
    const b = requestInjector(parent, 'user-b', async (options, context) => {
      seen.push(context);
      expect(options.headers).toEqual({
        cookie: 'session=user-b',
        'x-request-id': 'request-user-b',
      });
      return second.promise;
    });
    const contextA = a.get(SHIP_QUERY_CONTEXT);
    const contextB = b.get(SHIP_QUERY_CONTEXT);
    expect(contextA.queryClient).not.toBe(contextB.queryClient);
    expect(contextA.queryClient).toBe(a.get(QueryClient));
    expect(runInInjectionContext(a, injectQueryClient)).toBe(contextA.queryClient);
    const readA = read(a);
    const readB = read(b);
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.every(context => Object.isFrozen(context.forwardedHeaders))).toBe(true);
    first.resolve(success('private-a'));
    await readA;
    expect(contextB.queryClient.getQueryCache().getAll()[0]?.state.data).toBeUndefined();
    second.resolve(success('private-b'));
    await readB;
    expect(contextA.queryClient.getQueryCache().getAll()[0]?.state.data).toMatchObject({
      data: 'private-a',
    });
    expect(contextB.queryClient.getQueryCache().getAll()[0]?.state.data).toMatchObject({
      data: 'private-b',
    });
    await expect(contextA.scope.change('other')).rejects.toThrow('fixed');
    expect(TestBed.inject(TransferState).toJson()).toBe('{}');
  });

  it('does not mount a client, register browser listeners, or create transfer state', () => {
    const parent = parentInjector();
    const mount = vi.spyOn(QueryClient.prototype, 'mount');
    const unmount = vi.spyOn(QueryClient.prototype, 'unmount');
    const browserEvents = vi.spyOn(window, 'addEventListener');
    const injector = requestInjector(parent, 'a', async () => success('value'));
    const client = injector.get(QueryClient);
    expect(client.getDefaultOptions()).toEqual({
      queries: {
        staleTime: 30000,
        gcTime: Infinity,
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false, gcTime: Infinity },
    });
    expect(mount).not.toHaveBeenCalled();
    expect(browserEvents).not.toHaveBeenCalled();
    injector.destroy();
    expect(unmount).not.toHaveBeenCalled();
    expect(TestBed.inject(TransferState).toJson()).toBe('{}');
  });

  it.each(['success', 'failure', 'exception'] as const)(
    'holds one Angular pending task through %s',
    async outcome => {
      const parent = parentInjector();
      const response = deferred<Result>();
      const injector = requestInjector(parent, 'a', () => response.promise);
      const app = TestBed.inject(ApplicationRef);
      await app.whenStable();
      const add = vi.spyOn(TestBed.inject(PendingTasks), 'add');
      const started = read(injector).catch(error => error);
      let stable = false;
      const settled = app.whenStable().then(() => {
        stable = true;
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(stable).toBe(false);
      expect(add).toHaveBeenCalledTimes(1);
      if (outcome === 'exception') response.reject(new Error('connection failed'));
      else response.resolve(outcome === 'success' ? success('value') : failure());
      const result = await started;
      if (outcome === 'failure') expect(result).toBeInstanceOf(OperationApiError);
      if (outcome === 'exception') expect(result).toBeInstanceOf(Error);
      await settled;
      expect(stable).toBe(true);
      expect(TestBed.inject(TransferState).toJson()).toBe('{}');
    }
  );

  it('tracks the whole operation retry with one handle and no adapter retries', async () => {
    const parent = parentInjector();
    const delay = deferred<void>();
    const backoff = vi.fn(() => delay.promise);
    const handler = vi.fn(async (options: OperationExecutionOptions) =>
      options.attempt === 1 ? failure() : success('retried')
    );
    const injector = requestInjector(parent, 'a', handler, { retry: true, delay: backoff });
    const app = TestBed.inject(ApplicationRef);
    await app.whenStable();
    const add = vi.spyOn(TestBed.inject(PendingTasks), 'add');
    const started = read(injector);
    let stable = false;
    const settled = app.whenStable().then(() => {
      stable = true;
    });
    await vi.waitFor(() => expect(backoff).toHaveBeenCalledOnce());
    expect(stable).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
    delay.resolve();
    await expect(started).resolves.toMatchObject({ data: 'retried' });
    await settled;
    expect(handler).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it.each(['request', 'injector'] as const)(
    'cancels pending reads and clears owned state on %s termination',
    async source => {
      const parent = parentInjector();
      const controller = new AbortController();
      const begun = deferred<void>();
      let signal: AbortSignal | undefined;
      const injector = requestInjector(
        parent,
        'a',
        options => {
          signal = options.signal;
          begun.resolve();
          return new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            })
          );
        },
        { controller }
      );
      const { scope, queryClient } = injector.get(SHIP_QUERY_CONTEXT);
      const captured = scope.capture();
      const scopeSignal = scope.signal(captured);
      queryClient.setQueryData(['another-owned-key'], 'private');
      queryClient
        .getMutationCache()
        .build(queryClient, { mutationKey: ['another-owned-mutation'], gcTime: Infinity });
      const unrelated = new QueryClient();
      unrelated.setQueryData(['unrelated'], 'keep');
      const app = TestBed.inject(ApplicationRef);
      await app.whenStable();
      const started = read(injector).catch(error => error);
      await begun.promise;
      if (source === 'request') controller.abort();
      else injector.destroy();
      expect(signal?.aborted).toBe(true);
      expect(scopeSignal.aborted).toBe(true);
      expect(scope.isCurrent(captured)).toBe(false);
      expect(queryClient.getQueryCache().getAll()).toEqual([]);
      expect(queryClient.getMutationCache().getAll()).toEqual([]);
      expect(unrelated.getQueryData(['unrelated'])).toBe('keep');
      await started;
      await app.whenStable();
      await scope.destroy();
      unrelated.clear();
    }
  );

  it('respects trackPendingTasks false instead of creating its own handle', async () => {
    const parent = parentInjector();
    const response = deferred<Result>();
    const injector = requestInjector(parent, 'a', () => response.promise, {
      trackPendingTasks: false,
    });
    const app = TestBed.inject(ApplicationRef);
    await app.whenStable();
    const add = vi.spyOn(TestBed.inject(PendingTasks), 'add');
    const started = read(injector);
    await app.whenStable();
    expect(add).not.toHaveBeenCalled();
    response.resolve(success('value'));
    await started;
    expect(add).not.toHaveBeenCalled();
  });

  it('cleans up an already-aborted request and reports cleanup failures once', async () => {
    const parent = parentInjector();
    const controller = new AbortController();
    controller.abort();
    const aborted = requestInjector(parent, 'a', async () => success('unused'), { controller });
    expect(() => aborted.get(SHIP_QUERY_CONTEXT).scope.capture()).toThrow('destroyed');
    const live = requestInjector(parent, 'b', async () => success('unused'));
    const { scope, queryClient } = live.get(SHIP_QUERY_CONTEXT);
    scope.onCleanup(scope.capture(), () => {
      throw new Error('cleanup failed');
    });
    queryClient.setQueryData(['private'], 'data');
    live.destroy();
    await vi.waitFor(() => expect(handledErrors).toHaveLength(1));
    expect(handledErrors[0]).toBeInstanceOf(AggregateError);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('supports prerender without a request and snapshots configuration', () => {
    const parent = parentInjector();
    const config = { namespace: 'app@1', scopeKey: 'anonymous' };
    const provider = provideShipQueryServer(config);
    config.scopeKey = 'changed';
    const injector = createEnvironmentInjector(
      [{ provide: PLATFORM_ID, useValue: 'server' }, provider],
      parent
    );
    injectors.push(injector);
    expect(injector.get(SHIP_QUERY_CONTEXT).scope.capture().scopeKey).toBe('anonymous');
    injector.destroy();
  });

  it('accesses no browser globals or raw request fields and removes the abort listener', async () => {
    const parent = parentInjector();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const request = {
      signal: controller.signal,
      get headers() {
        throw new Error('raw headers accessed');
      },
      get url() {
        throw new Error('raw url accessed');
      },
    };
    const globals = ['window', 'document', 'navigator'] as const;
    const descriptors = globals.map(
      name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
    );
    let injector: EnvironmentInjector | undefined;
    try {
      for (const name of globals) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          get: () => {
            throw new Error(`${name} accessed`);
          },
        });
      }
      injector = createEnvironmentInjector(
        [
          { provide: PLATFORM_ID, useValue: 'server' },
          { provide: REQUEST, useValue: request },
          provideShipQueryServer({ namespace: 'app@1', scopeKey: 'user' }),
        ],
        parent
      );
      injectors.push(injector);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
        else Object.defineProperty(globalThis, name, descriptor);
      }
    }
    expect(injector).toBeDefined();
    const context = injector!.get(SHIP_QUERY_CONTEXT);
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    const clear = vi.spyOn(context.queryClient, 'clear');
    injector!.destroy();
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    controller.abort();
    await context.scope.destroy();
    expect(clear).toHaveBeenCalledOnce();
  });

  it.each(['server-server', 'server-browser', 'browser-server'] as const)(
    'rejects %s duplicate providers before allocating a client',
    order => {
      const parent = parentInjector();
      const config = { namespace: 'app@1', scopeKey: 'a' };
      const mount = vi.spyOn(QueryClient.prototype, 'mount');
      const providers = order
        .split('-')
        .map(kind =>
          kind === 'server' ? provideShipQueryServer(config) : provideShipQuery(config)
        );
      expect(() =>
        createEnvironmentInjector(
          [{ provide: PLATFORM_ID, useValue: 'server' }, ...providers],
          parent
        )
      ).toThrow('only once');
      expect(mount).not.toHaveBeenCalled();
    }
  );

  it('rejects browser use and invalid scope configuration', () => {
    const parent = parentInjector();
    expect(() =>
      createEnvironmentInjector(
        [
          { provide: PLATFORM_ID, useValue: 'browser' },
          provideShipQueryServer({ namespace: 'app@1', scopeKey: 'a' }),
        ],
        parent
      )
    ).toThrow('server request injector');
    expect(() => provideShipQueryServer({ namespace: '', scopeKey: 'a' })).toThrow(TypeError);
    expect(() => provideShipQueryServer({ namespace: 'app', scopeKey: '' })).toThrow(TypeError);
  });

  it('rejects a foreign native client override instead of bypassing owned initialization', () => {
    const parent = parentInjector();
    const foreign = new QueryClient();
    foreign.setQueryData(['foreign'], 'keep');
    const config = { namespace: 'app@1', scopeKey: 'a' };
    expect(() =>
      createEnvironmentInjector(
        [
          { provide: PLATFORM_ID, useValue: 'server' },
          provideShipQueryServer(config),
          { provide: QueryClient, useValue: foreign },
        ],
        parent
      )
    ).toThrow('owned client');
    expect(foreign.getQueryData(['foreign'])).toBe('keep');
    foreign.clear();
  });

  it('checks duplicate registration even when a foreign native token is last', () => {
    const parent = parentInjector();
    const config = { namespace: 'app@1', scopeKey: 'a' };
    expect(() =>
      createEnvironmentInjector(
        [
          { provide: PLATFORM_ID, useValue: 'server' },
          provideShipQueryServer(config),
          provideShipQueryServer(config),
          { provide: QueryClient, useValue: new QueryClient() },
        ],
        parent
      )
    ).toThrow('only once');
  });
});
