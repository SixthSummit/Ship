import {
  ApplicationRef,
  createEnvironmentInjector,
  EnvironmentInjector,
  InjectionToken,
  PendingTasks,
  PLATFORM_ID,
  provideZonelessChangeDetection,
  REQUEST,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationRequestPolicy } from './create-operation-request-policy';
import type { OperationClient } from './operation-client';
import type { OperationResultOf } from './operation-result';
import { provideShipClient } from './provide-ship-client';
import { createShipClientContext } from './ship-client-context';
import { createShipClientToken, injectShipClient } from './ship-client-token';
import { provideShipOperationBoundary } from './ship-operation-boundary';

interface TestContract {
  readonly 'status.get': {
    readonly input: Record<string, never>;
    readonly success: { readonly 200: { readonly ready: boolean } };
    readonly errors: 'UNAVAILABLE';
    readonly transport: 'http';
  };
}

type StatusResult = OperationResultOf<TestContract, 'status.get'>;

const CLIENT = createShipClientToken<TestContract>('TEST_CLIENT');
const POLICY = new InjectionToken<OperationRequestPolicy<TestContract>>('TEST_POLICY');

function fakeClient(label: string): OperationClient<TestContract> {
  return {
    call: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ready: label.length > 0 },
      headers: { headers: {} },
    })) as unknown as OperationClient<TestContract>['call'],
  };
}

function fakePolicy(label: string): OperationRequestPolicy<TestContract> {
  return { begin: vi.fn(() => label) } as unknown as OperationRequestPolicy<TestContract>;
}

afterEach(() => TestBed.resetTestingModule());

describe('typed Ship client provider', () => {
  it('provides and injects a client without an application cast', () => {
    const factory = vi.fn(() => fakeClient('browser'));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideShipClient(CLIENT, factory, { apiBaseUrl: 'https://api.example.test/v1/' }),
      ],
    });

    const client = TestBed.runInInjectionContext(() => injectShipClient(CLIENT));

    expect(client).toBe(TestBed.inject(CLIENT));
    expect(factory).toHaveBeenCalledWith({
      platform: 'browser',
      apiBaseUrl: 'https://api.example.test/v1',
      forwardedHeaders: {},
    });
  });

  it('creates one shared client/policy boundary per injector', () => {
    const client = fakeClient('boundary');
    const requestPolicy = {
      begin: vi.fn(),
    } as unknown as OperationRequestPolicy<TestContract>;
    const factory = vi.fn(() => ({ client, requestPolicy }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ...provideShipOperationBoundary(CLIENT, POLICY, factory, {
          apiBaseUrl: 'https://api.example.test',
          trackPendingTasks: false,
        }),
      ],
    });

    expect(TestBed.inject(CLIENT)).toBe(client);
    expect(TestBed.inject(POLICY)).toBe(requestPolicy);
    expect(TestBed.inject(CLIENT)).toBe(client);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      platform: 'browser',
      apiBaseUrl: 'https://api.example.test',
      forwardedHeaders: {},
    });
  });

  it('isolates complete operation boundaries across concurrent SSR injectors', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const parent = TestBed.inject(EnvironmentInjector);
    const makeInjector = (requestId: string, cookie: string) =>
      createEnvironmentInjector(
        [
          { provide: PLATFORM_ID, useValue: 'server' },
          {
            provide: REQUEST,
            useValue: new Request('https://site.example.test', {
              headers: { cookie, 'x-request-id': requestId },
            }),
          },
          ...provideShipOperationBoundary(
            CLIENT,
            POLICY,
            context => ({
              client: Object.assign(fakeClient(requestId), { context }),
              requestPolicy: Object.assign(fakePolicy(requestId), { context }),
            }),
            {
              apiBaseUrl: 'https://api.example.test',
              forwarding: { cookieNames: ['session'], headerNames: ['x-request-id'] },
              trackPendingTasks: false,
            }
          ),
        ],
        parent
      );
    const injectorA = makeInjector('request-a', 'session=user-a');
    const injectorB = makeInjector('request-b', 'session=user-b');

    const clientA = injectorA.get(CLIENT) as OperationClient<TestContract> & {
      context: { forwardedHeaders: Readonly<Record<string, string>> };
    };
    const clientB = injectorB.get(CLIENT) as typeof clientA;
    const policyA = injectorA.get(POLICY) as OperationRequestPolicy<TestContract> & {
      context: { forwardedHeaders: Readonly<Record<string, string>> };
    };
    const policyB = injectorB.get(POLICY) as typeof policyA;

    expect(clientA).not.toBe(clientB);
    expect(policyA).not.toBe(policyB);
    expect(clientA.context).toBe(policyA.context);
    expect(clientB.context).toBe(policyB.context);
    expect(policyA.context.forwardedHeaders.cookie).toBe('session=user-a');
    expect(policyB.context.forwardedHeaders.cookie).toBe('session=user-b');

    injectorA.destroy();
    injectorB.destroy();
  });

  it('creates isolated clients and contexts in overlapping SSR request injectors', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const parent = TestBed.inject(EnvironmentInjector);
    const makeInjector = (requestId: string, cookie: string) =>
      createEnvironmentInjector(
        [
          { provide: PLATFORM_ID, useValue: 'server' },
          {
            provide: REQUEST,
            useValue: new Request('https://site.example.test/page', {
              headers: {
                cookie,
                'x-request-id': requestId,
                authorization: `Bearer ${requestId}`,
              },
            }),
          },
          provideShipClient(CLIENT, context => Object.assign(fakeClient(requestId), { context }), {
            apiBaseUrl: 'https://api.example.test/v1',
            forwarding: { cookieNames: ['session'], headerNames: ['x-request-id'] },
          }),
        ],
        parent
      );
    const injectorA = makeInjector('request-a', 'session=user-a; analytics=one');
    const injectorB = makeInjector('request-b', 'session=user-b; analytics=two');

    const clientA = runInInjectionContext(injectorA, () => injectShipClient(CLIENT)) as ReturnType<
      typeof fakeClient
    > & { context: { forwardedHeaders: Readonly<Record<string, string>> } };
    const clientB = runInInjectionContext(injectorB, () =>
      injectShipClient(CLIENT)
    ) as typeof clientA;

    expect(clientA).not.toBe(clientB);
    expect(clientA.context.forwardedHeaders).toEqual({
      cookie: 'session=user-a',
      'x-request-id': 'request-a',
    });
    expect(clientB.context.forwardedHeaders).toEqual({
      cookie: 'session=user-b',
      'x-request-id': 'request-b',
    });
    expect(clientA.context.forwardedHeaders).not.toHaveProperty('authorization');

    injectorA.destroy();
    injectorB.destroy();
  });
});

describe('Ship operation boundary pending tasks', () => {
  function configureBoundary(
    call: OperationClient<TestContract>['call'],
    trackPendingTasks?: boolean
  ): void {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ...provideShipOperationBoundary(
          CLIENT,
          POLICY,
          () => ({ client: { call }, requestPolicy: fakePolicy('tasks') }),
          {
            apiBaseUrl: 'https://api.example.test',
            ...(trackPendingTasks === undefined ? {} : { trackPendingTasks }),
          }
        ),
      ],
    });
  }

  async function settle(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  it('holds application stability until an operation call settles', async () => {
    const result = deferred<StatusResult>();
    configureBoundary((async () => result.promise) as OperationClient<TestContract>['call']);
    const appRef = TestBed.inject(ApplicationRef);
    await appRef.whenStable();

    const pending = TestBed.inject(CLIENT).call('status.get', {});
    let stable = false;
    const stabilized = appRef.whenStable().then(() => {
      stable = true;
    });
    await settle();
    expect(stable).toBe(false);

    result.resolve({ ok: true, status: 200, data: { ready: true }, headers: { headers: {} } });
    await expect(pending).resolves.toMatchObject({ ok: true });
    await stabilized;
    expect(stable).toBe(true);
  });

  it('releases the pending task when a call aborts', async () => {
    configureBoundary(
      ((_operation, _input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            }
          );
        })) as OperationClient<TestContract>['call']
    );
    const appRef = TestBed.inject(ApplicationRef);
    const add = vi.spyOn(TestBed.inject(PendingTasks), 'add');
    const controller = new AbortController();

    const pending = TestBed.inject(CLIENT).call('status.get', {}, { signal: controller.signal });
    let stable = false;
    const stabilized = appRef.whenStable().then(() => {
      stable = true;
    });
    await settle();
    expect(add).toHaveBeenCalledTimes(1);
    expect(stable).toBe(false);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await stabilized;
    expect(stable).toBe(true);
  });

  it('registers no pending task when the boundary opts out', async () => {
    const call = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ready: true },
      headers: { headers: {} },
    })) as unknown as OperationClient<TestContract>['call'];
    configureBoundary(call, false);
    const add = vi.spyOn(TestBed.inject(PendingTasks), 'add');

    await expect(TestBed.inject(CLIENT).call('status.get', {})).resolves.toMatchObject({
      ok: true,
    });

    expect(call).toHaveBeenCalledWith('status.get', {});
    expect(add).not.toHaveBeenCalled();
  });

  it('tracks pending tasks inside an SSR request injector', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const parent = TestBed.inject(EnvironmentInjector);
    const result = deferred<StatusResult>();
    const injector = createEnvironmentInjector(
      [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: REQUEST, useValue: new Request('https://site.example.test') },
        ...provideShipOperationBoundary(
          CLIENT,
          POLICY,
          () => ({
            client: { call: (async () => result.promise) as OperationClient<TestContract>['call'] },
            requestPolicy: fakePolicy('ssr'),
          }),
          { apiBaseUrl: 'https://api.example.test' }
        ),
      ],
      parent
    );
    const add = vi.spyOn(TestBed.inject(PendingTasks), 'add');

    const pending = injector.get(CLIENT).call('status.get', {});
    await settle();
    expect(add).toHaveBeenCalledTimes(1);

    result.resolve({ ok: true, status: 200, data: { ready: true }, headers: { headers: {} } });
    await pending;
    await TestBed.inject(ApplicationRef).whenStable();
    injector.destroy();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Ship client request context', () => {
  it('forwards only explicitly approved headers, cookies, and the request signal', () => {
    const controller = new AbortController();
    const request = new Request('https://site.example.test/page', {
      signal: controller.signal,
      headers: {
        cookie: 'session=abc; preference=dark; analytics=tracking',
        'x-request-id': 'request-1',
        'accept-language': 'en-CA',
        traceparent: '00-trace-span-01',
        authorization: 'Bearer secret',
      },
    });

    const context = createShipClientContext('server', request, {
      apiBaseUrl: 'https://api.example.test/v1/',
      forwarding: {
        cookieNames: ['session', 'preference'],
        headerNames: ['x-request-id', 'accept-language', 'traceparent'],
      },
    });

    expect(context).toMatchObject({
      platform: 'server',
      apiBaseUrl: 'https://api.example.test/v1',
      forwardedHeaders: {
        cookie: 'session=abc; preference=dark',
        'x-request-id': 'request-1',
        'accept-language': 'en-CA',
        traceparent: '00-trace-span-01',
      },
    });
    expect(context.forwardedHeaders).not.toHaveProperty('authorization');
    expect(context.signal?.aborted).toBe(false);
    controller.abort();
    expect(context.signal?.aborted).toBe(true);
  });

  it('does not forward incoming request state in a browser context', () => {
    const context = createShipClientContext(
      'browser',
      new Request('https://site.example.test', {
        headers: { cookie: 'session=secret', 'x-request-id': 'server-only' },
      }),
      {
        apiBaseUrl: 'https://api.example.test',
        forwarding: { cookieNames: ['session'], headerNames: ['x-request-id'] },
      }
    );

    expect(context).toEqual({
      platform: 'browser',
      apiBaseUrl: 'https://api.example.test',
      forwardedHeaders: {},
    });
  });

  it('rejects sensitive generic header forwarding', () => {
    const request = new Request('https://site.example.test', {
      headers: { authorization: 'Bearer secret' },
    });

    expect(() =>
      createShipClientContext('server', request, {
        apiBaseUrl: 'https://api.example.test',
        forwarding: { headerNames: ['Authorization'] },
      })
    ).toThrow('cannot forward sensitive header');
  });

  it.each([
    ['ftp://api.example.test', 'http or https'],
    ['https://user:secret@api.example.test', 'must not contain credentials'],
    ['https://api.example.test?secret=yes', 'must not contain a query or fragment'],
    ['https://api.example.test#fragment', 'must not contain a query or fragment'],
  ])('rejects unsafe API base URL %s', (apiBaseUrl, message) => {
    expect(() => createShipClientContext('browser', null, { apiBaseUrl })).toThrow(message);
  });

  it('rejects invalid approved cookie names', () => {
    const request = new Request('https://site.example.test', {
      headers: { cookie: 'session=abc' },
    });

    expect(() =>
      createShipClientContext('server', request, {
        apiBaseUrl: 'https://api.example.test',
        forwarding: { cookieNames: ['session\ninvalid'] },
      })
    ).toThrow('invalid cookie name');
  });

  it('omits cookies when no approved cookie is present', () => {
    const request = new Request('https://site.example.test', {
      headers: { cookie: 'analytics=tracking' },
    });

    expect(
      createShipClientContext('server', request, {
        apiBaseUrl: 'https://api.example.test',
        forwarding: { cookieNames: ['session'] },
      }).forwardedHeaders
    ).toEqual({});
  });
});
