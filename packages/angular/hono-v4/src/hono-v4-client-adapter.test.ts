import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createOperationResource,
  type OperationClient,
  ProtocolError,
} from '@sixthsummit/ship-angular/operations';
import { describe, expect, it, vi } from 'vitest';
import { HonoV4ClientAdapter } from './hono-v4-client-adapter';

interface TestContract {
  readonly 'accounts.get': {
    readonly input: { readonly params: { readonly accountId: string } };
    readonly success: { readonly 200: { readonly id: string; readonly name: string } };
    readonly errors: 'ACCOUNT_NOT_FOUND';
    readonly transport: 'http';
  };
  readonly 'health.check': {
    readonly input: Record<string, never>;
    readonly success: { readonly 204: undefined };
    readonly errors: 'UNAVAILABLE';
    readonly transport: 'http';
  };
}

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

function adapter(response: () => Promise<Response>): HonoV4ClientAdapter<TestContract> {
  return new HonoV4ClientAdapter<TestContract>({
    'accounts.get': {
      invoke: response,
      declaredErrors: ['ACCOUNT_NOT_FOUND'],
      successStatuses: [200],
      decodeSuccess: decodeAccount,
      cancellation: 'forwarded',
    },
  });
}

describe('HonoV4ClientAdapter', () => {
  it('decodes a mapped JSON success and retains response metadata', async () => {
    const invoke = vi.fn(async () =>
      Response.json(
        { id: 'account-1', name: 'Ada' },
        { status: 200, headers: { 'X-Request-Id': 'request-1', ETag: 'version-1' } }
      )
    );
    const client = adapter(invoke);

    await expect(
      client.call('accounts.get', { params: { accountId: 'account-1' } })
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: { id: 'account-1', name: 'Ada' },
      headers: expect.objectContaining({ requestId: 'request-1', etag: 'version-1' }),
    });
    expect(invoke).toHaveBeenCalledWith(
      { params: { accountId: 'account-1' } },
      expect.objectContaining({})
    );
    expect(client.compatibility('accounts.get')).toEqual({
      mapped: true,
      cancellation: 'forwarded',
    });
    expect(client.compatibility('health.check')).toEqual({ mapped: false });
  });

  it('supports bodyless declared 204 responses', async () => {
    const client = new HonoV4ClientAdapter<TestContract>({
      'health.check': {
        invoke: async () => new Response(null, { status: 204 }),
        declaredErrors: ['UNAVAILABLE'],
        successStatuses: [204],
        decodeSuccess: () => undefined,
        cancellation: 'discard-only',
      },
    });

    await expect(client.call('health.check', {})).resolves.toMatchObject({
      ok: true,
      status: 204,
      data: undefined,
    });
  });

  it('normalizes declared and version-skew error envelopes', async () => {
    const declared = adapter(async () =>
      Response.json(
        {
          success: false,
          error: { code: 'ACCOUNT_NOT_FOUND', message: 'Missing', details: { id: 'x' } },
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
      error: { declared: true, code: 'ACCOUNT_NOT_FOUND', details: { id: 'x' } },
    });
    await expect(
      unknown.call('accounts.get', { params: { accountId: 'x' } })
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { declared: false, code: 'NEW_CODE' },
    });
  });

  it('maps 304 without trying to parse an empty body', async () => {
    const client = adapter(
      async () => new Response(null, { status: 304, headers: { ETag: 'version-1' } })
    );

    await expect(
      client.call('accounts.get', { params: { accountId: 'account-1' } })
    ).resolves.toMatchObject({
      ok: true,
      notModified: true,
      status: 304,
      headers: { etag: 'version-1' },
    });
  });

  it('reports missing mappings and undeclared success statuses', async () => {
    const missing = new HonoV4ClientAdapter<TestContract>({});
    await expect(missing.call('health.check', {})).rejects.toMatchObject({
      name: 'HonoV4CompatibilityError',
      reason: 'missing-operation-mapping',
      operation: 'health.check',
    });

    const drifted = adapter(async () => Response.json({ id: 'a', name: 'Ada' }, { status: 201 }));
    await expect(
      drifted.call('accounts.get', { params: { accountId: 'a' } })
    ).rejects.toMatchObject({
      name: 'HonoV4CompatibilityError',
      reason: 'unsupported-success-status',
      status: 201,
    });
  });

  it('distinguishes malformed success JSON, content type, and decoder failures', async () => {
    const malformed = adapter(
      async () =>
        new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const html = adapter(
      async () =>
        new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    );
    const wrongShape = adapter(async () => Response.json({ id: 1, name: 'Ada' }));

    await expect(
      malformed.call('accounts.get', { params: { accountId: 'a' } })
    ).rejects.toMatchObject({ name: 'ProtocolError', reason: 'invalid-json' });
    await expect(html.call('accounts.get', { params: { accountId: 'a' } })).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-content-type',
    });
    await expect(
      wrongShape.call('accounts.get', { params: { accountId: 'a' } })
    ).rejects.toMatchObject({ name: 'ProtocolError', reason: 'invalid-envelope' });
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
      message: 'The Hono v4 operation request failed',
      causeName: 'TypeError',
    });
  });

  it('rejects immediately on abort even when legacy transport can only discard', async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      finish = resolve;
    });
    const controller = new AbortController();
    const client = new HonoV4ClientAdapter<TestContract>({
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

  it('drives the same Angular resource behavior as a target structural client', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const target: OperationClient<TestContract> = {
      call: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { id: 'account-1', name: 'Ada' },
        headers: { headers: {}, requestId: 'target-request' },
      })) as unknown as OperationClient<TestContract>['call'],
    };
    const compatibility = adapter(async () =>
      Response.json(
        { id: 'account-1', name: 'Ada' },
        { headers: { 'X-Request-Id': 'compatibility-request' } }
      )
    );
    const create = (client: OperationClient<TestContract>) =>
      TestBed.runInInjectionContext(() =>
        createOperationResource(client, 'accounts.get', () => ({
          params: { accountId: 'account-1' },
        }))
      );
    const targetResource = create(target);
    const compatibilityResource = create(compatibility);

    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(compatibilityResource.value()).toEqual(targetResource.value());
    expect(compatibilityResource.status()).toBe(targetResource.status());
    expect(compatibilityResource.failure()).toBeUndefined();
    expect(compatibilityResource.metadata()?.requestId).toBe('compatibility-request');
  });
});
