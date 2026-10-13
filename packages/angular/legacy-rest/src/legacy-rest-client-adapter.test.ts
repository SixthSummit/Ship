import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createOperationResource,
  createPolicyClient,
  type OperationPolicyMap,
  type OperationTypeContract,
  ProtocolError,
} from '@sixthsummit/ship-angular/operations';
import { describe, expect, it, vi } from 'vitest';
import { LegacyRestClientAdapter } from './legacy-rest-client-adapter';

interface TestContract extends OperationTypeContract {
  readonly operations: {
    readonly 'accounts.get': {
      readonly transport: 'http';
      readonly input: { readonly params: { readonly accountId: string } };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 200;
            readonly data: { readonly id: string; readonly name: string };
          }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: { readonly code: 'ACCOUNT_NOT_FOUND' };
          };
    };
    readonly 'health.check': {
      readonly transport: 'http';
      readonly input: Record<string, never>;
      readonly result:
        | { readonly ok: true; readonly status: 204 }
        | {
            readonly ok: false;
            readonly status: 503;
            readonly error: { readonly code: 'UNAVAILABLE' };
          };
    };
  };
}

const policies: OperationPolicyMap<TestContract> = {
  'accounts.get': {
    authentication: 'required',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
  'health.check': {
    authentication: 'anonymous',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
};

function decodeAccount(value: unknown): { readonly id: string; readonly name: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('name' in value) ||
    typeof value.name !== 'string'
  ) {
    throw new Error('invalid account');
  }
  return { id: value.id, name: value.name };
}

function adapter(response: () => Promise<Response>): LegacyRestClientAdapter<TestContract> {
  return new LegacyRestClientAdapter<TestContract>({
    'accounts.get': {
      invoke: response,
      declaredErrors: ['ACCOUNT_NOT_FOUND'],
      successStatuses: [200],
      decodeSuccess: decodeAccount,
      cancellation: 'forwarded',
    },
  });
}

describe('LegacyRestClientAdapter', () => {
  it('decodes JSON success and retains response metadata', async () => {
    const invoke = vi.fn(async () =>
      Response.json(
        { id: 'account-1', name: 'Ada' },
        {
          status: 200,
          headers: {
            'X-Request-Id': 'request-1',
            ETag: 'version-1',
            'Content-Disposition': 'attachment; filename="account.json"',
          },
        }
      )
    );
    const client = adapter(invoke);

    await expect(
      client.call('accounts.get', { params: { accountId: 'account-1' } })
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: { id: 'account-1', name: 'Ada' },
      headers: expect.objectContaining({
        requestId: 'request-1',
        etag: 'version-1',
        contentDisposition: 'attachment; filename="account.json"',
      }),
    });
    expect(client.compatibility('accounts.get')).toEqual({
      mapped: true,
      cancellation: 'forwarded',
    });
    expect(client.compatibility('health.check')).toEqual({ mapped: false });
  });

  it('receives policy-prepared current credentials, headers, attempt, and signal', async () => {
    const invoke = vi.fn(async () => Response.json({ id: 'account-1', name: 'Ada' }));
    const client = createPolicyClient(adapter(invoke), {
      policies,
      credentials: { kind: 'bearer', getToken: async () => 'fresh-token' },
      requestId: { generate: () => 'request-1' },
    });

    await client.call('accounts.get', { params: { accountId: 'account-1' } });

    expect(invoke).toHaveBeenCalledWith(
      { params: { accountId: 'account-1' } },
      expect.objectContaining({
        attempt: 1,
        credentials: 'omit',
        headers: expect.objectContaining({
          authorization: 'Bearer fresh-token',
          'x-request-id': 'request-1',
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('supports declared bodyless 204 and cache 304 responses', async () => {
    const noContent = new LegacyRestClientAdapter<TestContract>({
      'health.check': {
        invoke: async () => new Response(null, { status: 204 }),
        declaredErrors: ['UNAVAILABLE'],
        successStatuses: [204],
        decodeSuccess: () => undefined,
        cancellation: 'discard-only',
      },
    });
    const notModified = adapter(
      async () => new Response(null, { status: 304, headers: { ETag: 'version-1' } })
    );

    await expect(noContent.call('health.check', {})).resolves.toMatchObject({
      ok: true,
      status: 204,
      data: undefined,
    });
    await expect(
      notModified.call('accounts.get', { params: { accountId: 'account-1' } })
    ).resolves.toMatchObject({
      ok: true,
      notModified: true,
      status: 304,
      headers: { etag: 'version-1' },
    });
  });

  it('preserves declared, unknown, and additive error data', async () => {
    const declared = adapter(async () =>
      Response.json(
        {
          success: false,
          requestId: 'envelope-request',
          correlation: 'safe-extra',
          error: {
            code: 'ACCOUNT_NOT_FOUND',
            message: 'Missing',
            details: { id: 'x' },
            category: 'domain',
          },
        },
        { status: 404 }
      )
    );
    const unknown = adapter(async () =>
      Response.json(
        { success: false, error: { code: 'NEW_CODE', message: 'Upgrade needed' } },
        { status: 409 }
      )
    );

    await expect(
      declared.call('accounts.get', { params: { accountId: 'x' } })
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: {
        declared: true,
        code: 'ACCOUNT_NOT_FOUND',
        details: { id: 'x' },
        requestId: 'envelope-request',
        extensions: { category: 'domain' },
        envelopeExtensions: { correlation: 'safe-extra' },
      },
    });
    await expect(
      unknown.call('accounts.get', { params: { accountId: 'x' } })
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { declared: false, code: 'NEW_CODE' },
    });
  });

  it('distinguishes malformed JSON, proxy HTML, and decoder failures', async () => {
    const malformed = adapter(
      async () =>
        new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const proxy = adapter(
      async () =>
        new Response('<html>gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
    );
    const wrongShape = adapter(async () => Response.json({ id: 1, name: 'Ada' }));

    await expect(
      malformed.call('accounts.get', { params: { accountId: 'a' } })
    ).rejects.toMatchObject({ name: 'ProtocolError', reason: 'invalid-json' });
    await expect(proxy.call('accounts.get', { params: { accountId: 'a' } })).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-content-type',
      status: 502,
    });
    await expect(
      wrongShape.call('accounts.get', { params: { accountId: 'a' } })
    ).rejects.toMatchObject({ name: 'ProtocolError', reason: 'invalid-envelope' });
  });

  it('reports missing mappings and undeclared successful status drift', async () => {
    const missing = new LegacyRestClientAdapter<TestContract>({});
    await expect(missing.call('health.check', {})).rejects.toMatchObject({
      name: 'LegacyRestCompatibilityError',
      reason: 'missing-operation-mapping',
      operation: 'health.check',
    });

    await expect(
      adapter(async () => Response.json({ id: 'a', name: 'Ada' }, { status: 201 })).call(
        'accounts.get',
        { params: { accountId: 'a' } }
      )
    ).rejects.toMatchObject({
      name: 'LegacyRestCompatibilityError',
      reason: 'unsupported-success-status',
      status: 201,
    });
  });

  it('preserves known operation exceptions and sanitizes raw transport failures', async () => {
    const protocol = new ProtocolError('known', { reason: 'invalid-envelope' });
    await expect(
      adapter(async () => Promise.reject(protocol)).call('accounts.get', {
        params: { accountId: 'a' },
      })
    ).rejects.toBe(protocol);

    await expect(
      adapter(async () => Promise.reject(new TypeError('secret network details'))).call(
        'accounts.get',
        { params: { accountId: 'a' } }
      )
    ).rejects.toMatchObject({
      name: 'TransportError',
      message: 'The legacy REST operation request failed',
      causeName: 'TypeError',
    });
  });

  it('rejects immediately on abort when a legacy request cannot be stopped', async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      finish = resolve;
    });
    const controller = new AbortController();
    const client = new LegacyRestClientAdapter<TestContract>({
      'accounts.get': {
        invoke: async () => response,
        declaredErrors: ['ACCOUNT_NOT_FOUND'],
        successStatuses: [200],
        decodeSuccess: decodeAccount,
        cancellation: 'discard-only',
      },
    });
    const pending = client.call(
      'accounts.get',
      { params: { accountId: 'a' } },
      { signal: controller.signal }
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'OperationAbortedError' });
    finish(Response.json({ id: 'a', name: 'late' }));

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      client.call('accounts.get', { params: { accountId: 'a' } }, { signal: alreadyAborted.signal })
    ).rejects.toMatchObject({ name: 'OperationAbortedError' });
  });

  it('drives the Angular operation resource without a legacy-specific surface', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const resource = TestBed.runInInjectionContext(() =>
      createOperationResource(
        adapter(async () => Response.json({ id: 'a', name: 'Ada' })),
        'accounts.get',
        () => ({ params: { accountId: 'a' } })
      )
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resource.value()).toEqual({ id: 'a', name: 'Ada' });
    expect(resource.failure()).toBeUndefined();
    expect(resource.status()).toBe('resolved');
  });
});
