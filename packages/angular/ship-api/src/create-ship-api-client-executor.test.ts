import {
  type OperationExecutionOptions,
  ProtocolError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { describe, expect, it, vi } from 'vitest';
import {
  createShipApiClientExecutor,
  type ShipApiClientContractManifest,
  type ShipApiClientResult,
  type ShipApiOperationClient,
} from './create-ship-api-client-executor';

interface Contract {
  readonly operations: {
    readonly 'accounts.get': {
      readonly transport: 'http';
      readonly input: { readonly params: { readonly accountId: string } };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 200;
            readonly data: { readonly id: string };
          }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: {
              readonly code: 'ACCOUNT_NOT_FOUND';
              readonly message: string;
            };
          };
    };
  };
}

const manifest: ShipApiClientContractManifest = {
  schemaVersion: 1,
  appId: 'adapter-test',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  operations: [
    {
      id: 'accounts.get',
      success: [{ status: 200 }],
      errors: [{ code: 'ACCOUNT_NOT_FOUND', status: 404 }],
    },
  ],
};

describe('createShipApiClientExecutor', () => {
  it('normalizes current ShipAPI successes and caches clients by credential mode', async () => {
    const client = fixtureClient(async (_operation, input, options) => ({
      ok: true,
      status: 200,
      data: { id: input.params.accountId },
      requestId: 'request-top-level',
      metadata: {
        requestId: 'request-metadata',
        headers: {
          ETag: 'account-v1',
          'Retry-After': '2',
          'Content-Type': 'application/json',
          'Idempotency-Replayed': 'true',
        },
      },
      fixtureExtension: true,
      receivedHeaders: options?.headers,
    }));
    const createClient = vi.fn(() => client);
    const executor = createShipApiClientExecutor<Contract>(manifest, createClient, {
      now: () => 100,
    });

    const first = await executor.call(
      'accounts.get',
      { params: { accountId: 'account-1' } },
      execution({ credentials: 'omit', headers: { authorization: 'Bearer current' } })
    );
    const second = await executor.call(
      'accounts.get',
      { params: { accountId: 'account-2' } },
      execution({ credentials: 'omit' })
    );
    await executor.call(
      'accounts.get',
      { params: { accountId: 'account-3' } },
      execution({ credentials: 'include' })
    );

    expect(first).toEqual({
      ok: true,
      status: 200,
      data: { id: 'account-1' },
      headers: {
        headers: {
          'content-type': 'application/json',
          etag: 'account-v1',
          'idempotency-replayed': 'true',
          'retry-after': '2',
        },
        requestId: 'request-top-level',
        retryAfterMs: 2000,
        etag: 'account-v1',
        contentType: 'application/json',
        idempotencyReplayed: true,
      },
    });
    expect(second).toMatchObject({ data: { id: 'account-2' } });
    expect(createClient).toHaveBeenNthCalledWith(1, { credentials: 'omit' });
    expect(createClient).toHaveBeenNthCalledWith(2, { credentials: 'include' });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(client.call).toHaveBeenCalledWith(
      'accounts.get',
      { params: { accountId: 'account-1' } },
      expect.objectContaining({ headers: { authorization: 'Bearer current' } })
    );
  });

  it('forwards keepalive to the structural client only when a call opts in', async () => {
    const client = fixtureClient(async () => ok());
    const executor = createShipApiClientExecutor<Contract>(manifest, () => client);

    await executor.call('accounts.get', { params: { accountId: 'account-1' } }, execution());
    await executor.call(
      'accounts.get',
      { params: { accountId: 'account-1' } },
      execution({ keepalive: true })
    );

    expect(client.call.mock.calls[0]?.[2]).not.toHaveProperty('keepalive');
    expect(client.call.mock.calls[1]?.[2]).toMatchObject({ keepalive: true });
  });

  it('keeps streaming HTTP responses outside the unary executor', async () => {
    const createClient = vi.fn(() => fixtureClient(async () => ok()));
    const streamingManifest: ShipApiClientContractManifest = {
      ...manifest,
      operations: [
        {
          ...manifest.operations[0]!,
          transport: { kind: 'http', metadata: { response: 'stream' } },
        },
      ],
    };
    const executor = createShipApiClientExecutor<Contract>(streamingManifest, createClient);

    await expect(
      executor.call('accounts.get', { params: { accountId: 'account-1' } }, execution())
    ).rejects.toThrow('Stream operations require a stream adapter');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('rejects a synchronous handle returned from a unary declaration', async () => {
    const executor = createShipApiClientExecutor<Contract>(
      manifest,
      () => ({ call: () => ({ cancel: vi.fn() }) }) as unknown as ShipApiOperationClient<Contract>
    );

    await expect(
      executor.call('accounts.get', { params: { accountId: 'account-1' } }, execution())
    ).rejects.toThrow('ShipAPI unary client returned a non-Promise value');
  });

  it('classifies declared, framework, and version-skew errors without losing extensions', async () => {
    const client = fixtureClient(async (_operation, input) => {
      const accountId = input.params.accountId;
      const status = accountId === 'declared' ? 404 : accountId === 'framework' ? 401 : 409;
      const code =
        accountId === 'declared'
          ? 'ACCOUNT_NOT_FOUND'
          : accountId === 'framework'
            ? 'AUTHENTICATION_ERROR'
            : accountId === 'in-flight'
              ? 'IDEMPOTENT_IN_FLIGHT'
              : 'FUTURE_CONFLICT';
      return {
        ok: false,
        status,
        requestId: `request-${accountId}`,
        metadata: { headers: { 'x-request-id': `request-${accountId}` } },
        outerFuture: 'retained',
        error: {
          code,
          message: 'Safe failure',
          details: { field: 'value' },
          errorFuture: 'retained',
        },
      };
    });
    const executor = createShipApiClientExecutor<Contract>(manifest, () => client);

    const declared = await call(executor, 'declared');
    const framework = await call(executor, 'framework');
    const inFlight = await call(executor, 'in-flight');
    const unknown = await call(executor, 'unknown');

    expect(declared).toMatchObject({
      ok: false,
      error: { declared: true, code: 'ACCOUNT_NOT_FOUND', requestId: 'request-declared' },
    });
    expect(framework).toMatchObject({
      ok: false,
      error: { declared: true, code: 'AUTHENTICATION_ERROR' },
    });
    expect(inFlight).toMatchObject({
      ok: false,
      status: 409,
      error: { declared: true, code: 'IDEMPOTENT_IN_FLIGHT' },
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: {
        declared: false,
        code: 'FUTURE_CONFLICT',
        extensions: { errorFuture: 'retained' },
        envelopeExtensions: { outerFuture: 'retained' },
      },
    });
  });

  it('normalizes 304 and metadata fields supplied outside the header map', async () => {
    const client = fixtureClient(async () => ({
      ok: true,
      status: 304,
      requestId: 'request-304',
      metadata: {
        headers: {},
        retryAfter: 'Thu, 01 Jan 1970 00:00:03 GMT',
        etag: 'account-v2',
        contentDisposition: 'attachment; filename="account.json"',
      },
    }));
    const executor = createShipApiClientExecutor<Contract>(manifest, () => client, {
      now: () => 1000,
    });

    await expect(call(executor, 'cached')).resolves.toEqual({
      ok: true,
      notModified: true,
      status: 304,
      headers: expect.objectContaining({
        requestId: 'request-304',
        retryAfterMs: 2000,
        etag: 'account-v2',
        contentDisposition: 'attachment; filename="account.json"',
      }),
    });
  });

  it('rejects invalid manifests, absent operations, and malformed result metadata', async () => {
    expect(() =>
      createShipApiClientExecutor<Contract>(
        { ...manifest, fingerprint: 'not-a-digest' as never },
        () => fixtureClient(async () => ok())
      )
    ).toThrow(ProtocolError);
    expect(() =>
      createShipApiClientExecutor<Contract>({ ...manifest, operations: [] }, () =>
        fixtureClient(async () => ok())
      )
    ).not.toThrow();
    expect(() =>
      createShipApiClientExecutor<Contract>(
        {
          ...manifest,
          operations: [
            { id: 'accounts.get', success: [{ status: 200 }], errors: [] },
            { id: 'accounts.get', success: [{ status: 200 }], errors: [] },
          ],
        },
        () => fixtureClient(async () => ok())
      )
    ).toThrow(ProtocolError);
    expect(() =>
      createShipApiClientExecutor<Contract>(
        {
          ...manifest,
          operations: [
            {
              id: 'accounts.get',
              success: [{ status: 200 }],
              errors: [{ code: '', status: 404 }],
            },
          ],
        },
        () => fixtureClient(async () => ok())
      )
    ).toThrow(ProtocolError);

    expect(() =>
      createShipApiClientExecutor<Contract>(
        {
          ...manifest,
          operations: [
            { id: 'accounts.get', success: [{ status: 200 }, { status: 200 }], errors: [] },
          ],
        },
        () => fixtureClient(async () => ok())
      )
    ).toThrow(ProtocolError);

    const absent = createShipApiClientExecutor<Contract>({ ...manifest, operations: [] }, () =>
      fixtureClient(async () => ok())
    );
    await expect(call(absent, 'missing')).rejects.toBeInstanceOf(ProtocolError);

    const malformed = createShipApiClientExecutor<Contract>(manifest, () =>
      fixtureClient(async () => ({
        ok: true,
        status: 200,
        data: { id: 'account-1' },
        metadata: { headers: {}, requestId: undefined },
      }))
    );
    await expect(call(malformed, 'metadata')).rejects.toMatchObject({
      name: 'ProtocolError',
      message: 'ShipAPI client result is missing its request ID',
    });

    const invalidResult = createShipApiClientExecutor<Contract>(manifest, () =>
      fixtureClient(async () => ({ ok: 'yes' }) as never)
    );
    await expect(call(invalidResult, 'result')).rejects.toMatchObject({
      name: 'ProtocolError',
      message: 'ShipAPI client returned an invalid operation result',
    });

    const invalidFailure = createShipApiClientExecutor<Contract>(manifest, () =>
      fixtureClient(async () => ({
        ok: false,
        status: 500,
        error: { code: '', message: 'invalid' },
        requestId: 'request-invalid',
        metadata: { headers: {} },
      }))
    );
    await expect(call(invalidFailure, 'failure')).rejects.toMatchObject({
      name: 'ProtocolError',
      message: 'ShipAPI client returned an invalid error result',
    });

    const undeclaredSuccess = createShipApiClientExecutor<Contract>(manifest, () =>
      fixtureClient(async () => ({ ...ok(), status: 201 }))
    );
    await expect(call(undeclaredSuccess, 'status')).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-status',
      status: 201,
    });
  });

  it('redacts network failures while preserving abort and stable ShipAPI diagnostics', async () => {
    const network = createShipApiClientExecutor<Contract>(manifest, () =>
      fixtureClient(async () => {
        throw new TypeError('private network address');
      })
    );
    const networkError = await call(network, 'network').catch((error: unknown) => error);
    expect(networkError).toBeInstanceOf(TransportError);
    expect(networkError).toMatchObject({ causeName: 'TypeError' });
    expect(JSON.stringify(networkError)).not.toContain('private network address');

    const abort = new DOMException('Aborted', 'AbortError');
    const aborted = createShipApiClientExecutor<Contract>(manifest, () =>
      fixtureClient(async () => {
        throw abort;
      })
    );
    await expect(call(aborted, 'abort')).rejects.toBe(abort);

    const diagnostic = Object.assign(new Error('Invalid generated input'), {
      code: 'SHIP_CLIENT_INPUT_INVALID',
    });
    const invalid = createShipApiClientExecutor<Contract>(manifest, () =>
      fixtureClient(async () => {
        throw diagnostic;
      })
    );
    await expect(call(invalid, 'diagnostic')).rejects.toBe(diagnostic);
  });
});

function fixtureClient(
  responder: (
    operation: 'accounts.get',
    input: { readonly params: { readonly accountId: string } },
    options?: {
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
      readonly idempotencyKey?: string;
      readonly keepalive?: boolean;
    }
  ) => Promise<ShipApiClientResult>
): ShipApiOperationClient<Contract> & { readonly call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(responder);
  return { call } as ShipApiOperationClient<Contract> & { readonly call: ReturnType<typeof vi.fn> };
}

function execution(overrides: Partial<OperationExecutionOptions> = {}): OperationExecutionOptions {
  return {
    signal: new AbortController().signal,
    headers: {},
    attempt: 1,
    ...overrides,
  };
}

function ok(): ShipApiClientResult {
  return {
    ok: true,
    status: 200,
    data: { id: 'account-1' },
    requestId: 'request-ok',
    metadata: { headers: { 'x-request-id': 'request-ok' } },
  };
}

function call(
  executor: OperationExecutorContract,
  accountId: string
): Promise<OperationResultOfContract> {
  return executor.call(
    'accounts.get',
    { params: { accountId } },
    execution({ credentials: 'omit' })
  );
}

type OperationExecutorContract = ReturnType<typeof createShipApiClientExecutor<Contract>>;
type OperationResultOfContract =
  ReturnType<OperationExecutorContract['call']> extends Promise<infer TResult> ? TResult : never;
