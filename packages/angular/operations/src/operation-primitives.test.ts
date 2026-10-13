import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { OperationAbortedError } from './operation-aborted-error';
import type { OperationClient } from './operation-client';
import type { ErrorCodeOf, InputOf, OperationId, TransportOf } from './operation-contract';
import type { OperationResultOf } from './operation-result';
import { OperationTimeoutError } from './operation-timeout-error';
import { ProtocolError } from './protocol-error';
import { EMPTY_RESPONSE_METADATA } from './response-metadata';
import { TransportError } from './transport-error';

interface ReferenceContract {
  readonly 'accounts.get': {
    readonly input: { readonly params: { readonly accountId: string } };
    readonly success: { readonly 200: { readonly id: string; readonly name: string } };
    readonly errors: 'AUTHENTICATION_ERROR' | 'ACCOUNT_NOT_FOUND';
    readonly transport: 'http';
  };
  readonly 'accounts.create': {
    readonly input: { readonly body: { readonly name: string } };
    readonly success: { readonly 201: { readonly id: string } };
    readonly errors: 'VALIDATION_ERROR' | 'CONFLICT';
    readonly transport: 'http';
  };
}

describe('operation contract primitives', () => {
  it('infers operation IDs, inputs, transports, and declared error codes', () => {
    expectTypeOf<OperationId<ReferenceContract>>().toEqualTypeOf<
      'accounts.get' | 'accounts.create'
    >();
    expectTypeOf<InputOf<ReferenceContract, 'accounts.get'>>().toEqualTypeOf<{
      readonly params: { readonly accountId: string };
    }>();
    expectTypeOf<TransportOf<ReferenceContract, 'accounts.get'>>().toEqualTypeOf<'http'>();
    expectTypeOf<ErrorCodeOf<ReferenceContract, 'accounts.create'>>().toEqualTypeOf<
      'VALIDATION_ERROR' | 'CONFLICT'
    >();
  });

  it('narrows status-indexed success and declared failure branches', () => {
    type Result = OperationResultOf<ReferenceContract, 'accounts.create'>;
    const result = {
      ok: true,
      status: 201,
      data: { id: 'account-1' },
      headers: EMPTY_RESPONSE_METADATA,
    } as const satisfies Result;

    expect(result.status).toBe(201);
    expectTypeOf(result.data).toEqualTypeOf<{ readonly id: 'account-1' }>();
  });

  it('accepts a client implemented only through the structural call method', () => {
    const call = vi.fn<OperationClient<ReferenceContract>['call']>();
    const client: OperationClient<ReferenceContract> = {
      call,
    };

    const pending = client.call('accounts.get', { params: { accountId: 'account-1' } });

    expect(call).toHaveBeenCalledWith('accounts.get', {
      params: { accountId: 'account-1' },
    });
    expectTypeOf(pending).toEqualTypeOf<
      Promise<OperationResultOf<ReferenceContract, 'accounts.get'>>
    >();
  });
});

describe('exceptional operation failures', () => {
  it('retains safe transport diagnostics without a raw cause', () => {
    const error = new TransportError('The API could not be reached', {
      reason: 'cors',
      causeName: 'TypeError',
      metadata: EMPTY_RESPONSE_METADATA,
    });

    expect(error).toMatchObject({
      name: 'TransportError',
      kind: 'transport',
      reason: 'cors',
      causeName: 'TypeError',
      metadata: EMPTY_RESPONSE_METADATA,
    });
    expect(error.cause).toBeUndefined();
  });

  it('defaults transport failures to the network category', () => {
    expect(new TransportError('Network failed').reason).toBe('network');
  });

  it('retains protocol category and response context', () => {
    const error = new ProtocolError('Expected JSON error envelope', {
      reason: 'unexpected-content-type',
      status: 502,
      metadata: EMPTY_RESPONSE_METADATA,
      receivedContentType: 'text/html',
    });

    expect(error).toMatchObject({
      name: 'ProtocolError',
      kind: 'protocol',
      reason: 'unexpected-content-type',
      status: 502,
      receivedContentType: 'text/html',
    });
  });

  it('distinguishes deadline and caller cancellation', () => {
    expect(new OperationTimeoutError(250)).toMatchObject({
      name: 'OperationTimeoutError',
      kind: 'timeout',
      timeoutMs: 250,
      message: 'Operation timed out after 250ms',
    });
    expect(new OperationAbortedError()).toMatchObject({
      name: 'OperationAbortedError',
      kind: 'aborted',
      message: 'Operation was aborted',
    });
    expect(new OperationAbortedError('SSR request ended').message).toBe('SSR request ended');
  });
});
