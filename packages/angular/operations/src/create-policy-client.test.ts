import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationRequestPolicy } from './create-operation-request-policy';
import { createPolicyClient, createPolicyClientFromPolicy } from './create-policy-client';
import type { CredentialCapability } from './credential-capability';
import { OperationAbortedError } from './operation-aborted-error';
import type { OperationExecutionOptions, OperationExecutor } from './operation-client';
import type { OperationPolicyMap } from './operation-policy';
import { OperationPolicyError } from './operation-policy-error';
import type { OperationResult } from './operation-result';
import { OperationTimeoutError } from './operation-timeout-error';

interface PolicyContract {
  readonly 'safe.get': {
    readonly input: { readonly query?: { readonly page?: number } };
    readonly success: { readonly 200: { readonly value: string } };
    readonly errors: 'RATE_LIMITED' | 'AUTHENTICATION_ERROR';
    readonly transport: 'http';
  };
  readonly 'unsafe.create': {
    readonly input: { readonly body: { readonly value: string } };
    readonly success: { readonly 201: { readonly id: string } };
    readonly errors: 'RATE_LIMITED';
    readonly transport: 'http';
  };
  readonly 'required.create': {
    readonly input: { readonly body: { readonly value: string } };
    readonly success: { readonly 201: { readonly id: string } };
    readonly errors: 'RATE_LIMITED';
    readonly transport: 'http';
  };
  readonly 'cookie.update': {
    readonly input: { readonly body: { readonly value: string } };
    readonly success: { readonly 200: { readonly saved: true } };
    readonly errors: 'AUTHENTICATION_ERROR';
    readonly transport: 'http';
  };
  readonly 'public.get': {
    readonly input: Record<string, never>;
    readonly success: { readonly 200: { readonly public: true } };
    readonly errors: 'UNAVAILABLE';
    readonly transport: 'http';
  };
}

const policies: OperationPolicyMap<PolicyContract> = {
  'safe.get': {
    authentication: 'optional',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
    retry: { maxAttempts: 3, statuses: [429, 503] },
  },
  'unsafe.create': {
    authentication: 'required',
    safety: 'unsafe',
    idempotency: 'supported',
    replayable: true,
    retry: { maxAttempts: 2, statuses: [429, 503] },
  },
  'required.create': {
    authentication: 'required',
    safety: 'unsafe',
    idempotency: 'required',
    replayable: true,
  },
  'cookie.update': {
    authentication: 'required',
    safety: 'unsafe',
    idempotency: 'unsupported',
    replayable: true,
    csrf: true,
  },
  'public.get': {
    authentication: 'anonymous',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
};

const emptyMetadata = { headers: {} } as const;

function success<T>(data: T, status = 200): OperationResult<T, never> {
  return { ok: true, status, data, headers: emptyMetadata };
}

function failure(
  status: number,
  retryAfterMs?: number,
  code: 'RATE_LIMITED' | 'AUTHENTICATION_ERROR' = 'RATE_LIMITED'
): OperationResult<never, 'RATE_LIMITED' | 'AUTHENTICATION_ERROR'> {
  return {
    ok: false,
    status,
    error: { declared: true, code, message: code },
    headers: { headers: {}, retryAfterMs },
  };
}

function executorFrom(
  handler: (
    operation: keyof PolicyContract,
    options: OperationExecutionOptions
  ) => Promise<OperationResult<unknown, string>>
): OperationExecutor<PolicyContract> {
  return {
    call: ((operation: keyof PolicyContract, _input: unknown, options: OperationExecutionOptions) =>
      handler(operation, options)) as OperationExecutor<PolicyContract>['call'],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('operation policy credentials and headers', () => {
  it('can share one request-policy instance with non-JSON transports', async () => {
    const requestPolicy = createOperationRequestPolicy<PolicyContract>({ policies });
    const begin = vi.spyOn(requestPolicy, 'begin');
    const client = createPolicyClientFromPolicy(
      executorFrom(async () => success({ value: 'shared' })),
      requestPolicy
    );

    await expect(client.call('safe.get', {})).resolves.toMatchObject({
      ok: true,
      data: { value: 'shared' },
    });
    expect(begin).toHaveBeenCalledWith('safe.get', {});
  });

  it('resolves a fresh bearer token on every approved retry', async () => {
    const attempts: OperationExecutionOptions[] = [];
    const executor = executorFrom(async (_operation, options) => {
      attempts.push(options);
      return options.attempt === 1 ? failure(429, 1_500) : success({ value: 'ready' });
    });
    const getToken = vi.fn(async ({ attempt }: { attempt: number }) => `token-${attempt}`);
    const delay = vi.fn(async () => undefined);
    const client = createPolicyClient(executor, {
      policies,
      credentials: { kind: 'bearer', getToken },
      requestId: { generate: () => 'request-1' },
      delay,
    });

    await expect(client.call('safe.get', {})).resolves.toMatchObject({ ok: true });

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(attempts.map(attempt => attempt.headers?.['authorization'])).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
    expect(attempts.map(attempt => attempt.headers?.['x-request-id'])).toEqual([
      'request-1',
      'request-1',
    ]);
    expect(attempts.map(attempt => attempt.attempt)).toEqual([1, 2]);
    expect(attempts.map(attempt => attempt.credentials)).toEqual(['omit', 'omit']);
    expect(delay).toHaveBeenCalledWith(1_500, expect.any(AbortSignal));
  });

  it('allows optional bearer authentication to proceed without a token', async () => {
    const execute = vi.fn(
      async (_operation: keyof PolicyContract, _options: OperationExecutionOptions) =>
        success({ value: 'anonymous' })
    );
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: { kind: 'bearer', getToken: async () => null },
    });

    await client.call('safe.get', {});

    expect(execute.mock.calls[0]?.[1].headers).not.toHaveProperty('authorization');
  });

  it('rejects a required call when no current credential exists', async () => {
    const execute = vi.fn(async () => success({ id: 'created' }, 201));
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: { kind: 'bearer', getToken: async () => null },
    });

    await expect(client.call('unsafe.create', { body: { value: 'x' } })).rejects.toMatchObject({
      reason: 'missing-credential',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('redacts a credential-provider failure to its error class name', async () => {
    const secretProviderError = new TypeError('provider token secret');
    const client = createPolicyClient(
      executorFrom(async () => success({ value: 'x' })),
      {
        policies,
        credentials: {
          kind: 'bearer',
          getToken: async () => Promise.reject(secretProviderError),
        },
      }
    );

    const rejection = await client.call('safe.get', {}).catch(error => error);

    expect(rejection).toMatchObject({
      name: 'OperationPolicyError',
      reason: 'credential-failed',
      causeName: 'TypeError',
    });
    expect(JSON.stringify(rejection)).not.toContain('provider token secret');
  });

  it('supplies cookie credentials and a current CSRF token', async () => {
    const execute = vi.fn(
      async (_operation: keyof PolicyContract, _options: OperationExecutionOptions) =>
        success({ saved: true })
    );
    const getCsrfToken = vi.fn(async () => 'csrf-current');
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      baseHeaders: { cookie: 'session=server-session' },
      credentials: {
        kind: 'cookie',
        credentials: 'same-origin',
        getCsrfToken,
        csrfHeaderName: 'X-Ship-CSRF',
      },
    });

    await client.call('cookie.update', { body: { value: 'x' } });

    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      headers: { cookie: 'session=server-session', 'x-ship-csrf': 'csrf-current' },
    });
    expect(getCsrfToken).toHaveBeenCalledTimes(1);
  });

  it('does not consult configured credentials for anonymous operations', async () => {
    const getToken = vi.fn(async () => 'must-not-be-used');
    const execute = vi.fn(
      async (_operation: keyof PolicyContract, _options: OperationExecutionOptions) =>
        success({ public: true })
    );
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      baseHeaders: {
        cookie: 'session=must-not-leak',
        authorization: 'Bearer must-not-leak',
        'x-csrf-token': 'must-not-leak',
      },
      credentials: { kind: 'bearer', getToken },
    });

    await client.call('public.get', {});

    expect(getToken).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[1].headers).not.toHaveProperty('authorization');
    expect(execute.mock.calls[0]?.[1].headers).not.toHaveProperty('cookie');
    expect(execute.mock.calls[0]?.[1].headers).not.toHaveProperty('x-csrf-token');
    expect(execute.mock.calls[0]?.[1].credentials).toBe('omit');
  });

  it('preserves a caller request ID but rejects caller-supplied credential headers', async () => {
    const execute = vi.fn(
      async (_operation: keyof PolicyContract, _options: OperationExecutionOptions) =>
        success({ value: 'x' })
    );
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      requestId: { headerName: 'X-Correlation-ID', generate: () => 'generated' },
    });

    await client.call(
      'safe.get',
      {},
      { headers: { 'X-Correlation-ID': 'caller-request', 'X-Feature': 'enabled' } }
    );
    expect(execute.mock.calls[0]?.[1].headers).toMatchObject({
      'x-correlation-id': 'caller-request',
      'x-feature': 'enabled',
    });

    await expect(
      client.call('safe.get', {}, { headers: { Authorization: 'Bearer caller-secret' } })
    ).rejects.toMatchObject({ reason: 'sensitive-header' });
  });

  it('rejects unavailable or incompatible CSRF capabilities before I/O', async () => {
    const execute = vi.fn(async () => success({ saved: true }));
    const missingSupplier = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: { kind: 'cookie' },
    });
    const missingToken = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: { kind: 'cookie', getCsrfToken: async () => null },
    });
    const bearer = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: { kind: 'bearer', getToken: async () => 'token' },
    });

    await expect(
      missingSupplier.call('cookie.update', { body: { value: 'x' } })
    ).rejects.toMatchObject({ reason: 'csrf-unavailable' });
    await expect(
      missingToken.call('cookie.update', { body: { value: 'x' } })
    ).rejects.toMatchObject({ reason: 'csrf-unavailable' });
    await expect(bearer.call('cookie.update', { body: { value: 'x' } })).rejects.toMatchObject({
      reason: 'csrf-unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('operation policy retry and idempotency', () => {
  const bearer: CredentialCapability<PolicyContract> = {
    kind: 'bearer',
    getToken: async () => 'token',
  };

  it('returns an unsafe retryable failure after exactly one attempt without a key', async () => {
    const execute = vi.fn(async () => failure(503));
    const delay = vi.fn(async () => undefined);
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: bearer,
      delay,
    });

    await expect(client.call('unsafe.create', { body: { value: 'money' } })).resolves.toMatchObject(
      { ok: false, status: 503 }
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('retries an unsafe replayable operation only with declared support and a stable key', async () => {
    const execute = vi.fn(async (_operation, options: OperationExecutionOptions) =>
      options.attempt === 1 ? failure(503) : success({ id: 'created' }, 201)
    );
    const delay = vi.fn(async () => undefined);
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: bearer,
      retry: { baseDelayMs: 100, maxDelayMs: 500 },
      delay,
    });

    await expect(
      client.call(
        'unsafe.create',
        { body: { value: 'money' } },
        { idempotencyKey: 'stable-create-key' }
      )
    ).resolves.toMatchObject({ ok: true, status: 201 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(call => call[1].idempotencyKey)).toEqual([
      'stable-create-key',
      'stable-create-key',
    ]);
    expect(delay).toHaveBeenCalledWith(100, expect.any(AbortSignal));
  });

  it('omits keepalive by default and preserves it on every retry attempt', async () => {
    const execute = vi.fn(async (_operation, options: OperationExecutionOptions) =>
      options.attempt === 1 ? failure(503) : success({ value: 'ready' })
    );
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      delay: vi.fn(async () => undefined),
    });

    await expect(client.call('safe.get', {})).resolves.toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(call => !('keepalive' in call[1]))).toBe(true);

    execute.mockClear();
    await expect(client.call('safe.get', {}, { keepalive: true })).resolves.toMatchObject({
      ok: true,
    });
    expect(execute.mock.calls.map(call => call[1].keepalive)).toEqual([true, true]);
    expect(execute.mock.calls.map(call => call[1].attempt)).toEqual([1, 2]);
  });

  it('never backoff-retries authentication or authorization denial', async () => {
    const execute = vi.fn(async () => failure(401, undefined, 'AUTHENTICATION_ERROR'));
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: bearer,
      delay: vi.fn(async () => undefined),
    });

    await expect(client.call('safe.get', {})).resolves.toMatchObject({ status: 401 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('performs exactly one explicitly declared credential refresh after a 401', async () => {
    const refreshPolicies: OperationPolicyMap<PolicyContract> = {
      ...policies,
      'safe.get': { ...policies['safe.get'], refreshAuthentication: true },
    };
    let refreshed = false;
    const refresh = vi.fn(async () => {
      refreshed = true;
    });
    const getToken = vi.fn(async () => (refreshed ? 'fresh-token' : 'stale-token'));
    const execute = vi.fn(async (_operation, options: OperationExecutionOptions) =>
      options.attempt === 1
        ? failure(401, undefined, 'AUTHENTICATION_ERROR')
        : success({ value: options.headers?.['authorization'] ?? 'missing' })
    );
    const client = createPolicyClient(executorFrom(execute), {
      policies: refreshPolicies,
      credentials: { kind: 'bearer', getToken, refresh },
    });

    await expect(client.call('safe.get', {})).resolves.toMatchObject({
      ok: true,
      data: { value: 'Bearer fresh-token' },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns a second 401 without refreshing more than once', async () => {
    const refreshPolicies: OperationPolicyMap<PolicyContract> = {
      ...policies,
      'safe.get': { ...policies['safe.get'], refreshAuthentication: true },
    };
    const refresh = vi.fn(async () => undefined);
    const execute = vi.fn(async () => failure(401, undefined, 'AUTHENTICATION_ERROR'));
    const client = createPolicyClient(executorFrom(execute), {
      policies: refreshPolicies,
      credentials: { kind: 'bearer', getToken: async () => 'token', refresh },
    });

    await expect(client.call('safe.get', {})).resolves.toMatchObject({ ok: false, status: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly when declared refresh capability is absent or fails', async () => {
    const refreshPolicies: OperationPolicyMap<PolicyContract> = {
      ...policies,
      'safe.get': { ...policies['safe.get'], refreshAuthentication: true },
    };
    const execute = vi.fn(async () => failure(401, undefined, 'AUTHENTICATION_ERROR'));
    const missing = createPolicyClient(executorFrom(execute), {
      policies: refreshPolicies,
      credentials: { kind: 'bearer', getToken: async () => 'token' },
    });
    const broken = createPolicyClient(executorFrom(execute), {
      policies: refreshPolicies,
      credentials: {
        kind: 'bearer',
        getToken: async () => 'token',
        refresh: async () => Promise.reject(new TypeError('provider secret')),
      },
    });

    await expect(missing.call('safe.get', {})).rejects.toMatchObject({
      reason: 'missing-refresh-capability',
    });
    await expect(broken.call('safe.get', {})).rejects.toMatchObject({
      reason: 'credential-failed',
      causeName: 'TypeError',
    });
  });

  it('keeps auth refresh separate from approved rate-limit retry attempts', async () => {
    const refreshPolicies: OperationPolicyMap<PolicyContract> = {
      ...policies,
      'safe.get': { ...policies['safe.get'], refreshAuthentication: true },
    };
    const execute = vi.fn(async (_operation, options: OperationExecutionOptions) => {
      if (options.attempt === 1) return failure(401, undefined, 'AUTHENTICATION_ERROR');
      if (options.attempt === 2) return failure(503);
      return success({ value: 'ready' });
    });
    const delay = vi.fn(async () => undefined);
    const client = createPolicyClient(executorFrom(execute), {
      policies: refreshPolicies,
      credentials: {
        kind: 'cookie',
        refresh: async () => undefined,
      },
      delay,
    });

    await expect(client.call('safe.get', {})).resolves.toMatchObject({ ok: true });
    expect(execute.mock.calls.map(call => call[1].attempt)).toEqual([1, 2, 3]);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it('rejects refresh policy on an anonymous operation before I/O', async () => {
    const invalidPolicies: OperationPolicyMap<PolicyContract> = {
      ...policies,
      'public.get': { ...policies['public.get'], refreshAuthentication: true },
    };
    const execute = vi.fn(async () => success({ public: true }));
    const client = createPolicyClient(executorFrom(execute), { policies: invalidPolicies });

    await expect(client.call('public.get', {})).rejects.toMatchObject({
      reason: 'missing-refresh-capability',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unsupported and missing required idempotency keys before I/O', async () => {
    const execute = vi.fn(async () => success({ value: 'x' }));
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: bearer,
    });

    await expect(
      client.call('safe.get', {}, { idempotencyKey: 'not-supported' })
    ).rejects.toMatchObject({ reason: 'idempotency-unsupported' });
    await expect(client.call('required.create', { body: { value: 'x' } })).rejects.toMatchObject({
      reason: 'idempotency-required',
    });
    await expect(
      client.call('required.create', { body: { value: 'x' } }, { idempotencyKey: '' })
    ).rejects.toMatchObject({ reason: 'idempotency-required' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses bounded exponential backoff when the server omits Retry-After', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async (_operation, options: OperationExecutionOptions) =>
      options.attempt === 1 ? failure(503) : success({ value: 'ready' })
    );
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      retry: { baseDelayMs: 250, maxDelayMs: 1_000 },
    });
    const pending = client.call('safe.get', {});

    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(call => call[1].credentials === 'omit')).toBe(true);
  });

  it('rejects malformed retry metadata before I/O', async () => {
    const invalidPolicies: OperationPolicyMap<PolicyContract> = {
      ...policies,
      'safe.get': { ...policies['safe.get'], retry: { maxAttempts: 0, statuses: [503] } },
    };
    const execute = vi.fn(async () => success({ value: 'x' }));
    const client = createPolicyClient(executorFrom(execute), { policies: invalidPolicies });

    await expect(client.call('safe.get', {})).rejects.toMatchObject({
      reason: 'invalid-retry-policy',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports a missing runtime policy as contract skew', async () => {
    const execute = vi.fn(async () => success({ value: 'x' }));
    const client = createPolicyClient(executorFrom(execute), {
      policies: {} as OperationPolicyMap<PolicyContract>,
    });

    await expect(client.call('safe.get', {})).rejects.toMatchObject({
      reason: 'missing-operation-policy',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('operation policy cancellation and deadlines', () => {
  it('rejects an already-aborted caller without executing', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => success({ value: 'x' }));
    const client = createPolicyClient(executorFrom(execute), { policies });

    await expect(client.call('safe.get', {}, { signal: controller.signal })).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('aborts retry backoff immediately', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => failure(503));
    const delay = vi.fn(
      async (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new OperationAbortedError()), {
            once: true,
          });
        })
    );
    const client = createPolicyClient(executorFrom(execute), { policies, delay });
    const pending = client.call('safe.get', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(delay).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(OperationAbortedError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('aborts the built-in backoff when the SSR request signal ends', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const execute = vi.fn(async () => failure(503));
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      signal: controller.signal,
    });
    const pending = client.call('safe.get', {});
    const rejection = expect(pending).rejects.toBeInstanceOf(OperationAbortedError);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('turns deadline cancellation into OperationTimeoutError', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(
      async (_operation: keyof PolicyContract, options: OperationExecutionOptions) =>
        new Promise<OperationResult<unknown, string>>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const client = createPolicyClient(executorFrom(execute), { policies });
    const pending = client.call('safe.get', {}, { timeoutMs: 25 });
    const rejection = expect(pending).rejects.toBeInstanceOf(OperationTimeoutError);

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('turns cancellation during credential supply into the same timeout category', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => success({ value: 'x' }));
    const client = createPolicyClient(executorFrom(execute), {
      policies,
      credentials: {
        kind: 'bearer',
        getToken: async request =>
          new Promise<string>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          }),
      },
    });
    const pending = client.call('safe.get', {}, { timeoutMs: 10 });
    const rejection = expect(pending).rejects.toBeInstanceOf(OperationTimeoutError);

    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s before I/O',
    async timeoutMs => {
      const execute = vi.fn(async () => success({ value: 'x' }));
      const client = createPolicyClient(executorFrom(execute), { policies });

      await expect(client.call('safe.get', {}, { timeoutMs })).rejects.toBeInstanceOf(
        OperationPolicyError
      );
      expect(execute).not.toHaveBeenCalled();
    }
  );
});
