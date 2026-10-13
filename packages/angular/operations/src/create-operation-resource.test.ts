import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { createOperationResource } from './create-operation-resource';
import type { OperationCallOptions, OperationClient } from './operation-client';
import type { OperationResultOf } from './operation-result';
import { EMPTY_RESPONSE_METADATA } from './response-metadata';

interface TestContract {
  readonly 'accounts.get': {
    readonly input: { readonly params: { readonly accountId: string } };
    readonly success: { readonly 200: { readonly id: string; readonly name: string } };
    readonly errors: 'ACCOUNT_NOT_FOUND';
    readonly transport: 'http';
  };
}

type AccountResult = OperationResultOf<TestContract, 'accounts.get'>;
type AccountInput = TestContract['accounts.get']['input'];

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(): void {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
}

function fakeClient(
  handler: (
    input: AccountInput,
    options: OperationCallOptions | undefined
  ) => Promise<AccountResult>
): OperationClient<TestContract> {
  return {
    call: ((_operation, input, options) =>
      handler(input, options)) as OperationClient<TestContract>['call'],
  };
}

function success(id: string, etag?: string): AccountResult {
  return {
    ok: true,
    status: 200,
    data: { id, name: `Account ${id}` },
    headers: etag === undefined ? EMPTY_RESPONSE_METADATA : { headers: { etag }, etag },
  };
}

describe('createOperationResource', () => {
  it('starts asynchronously and exposes typed data and response metadata', async () => {
    setup();
    const call = vi.fn(async () => success('a'));
    const resource = TestBed.runInInjectionContext(() =>
      createOperationResource(fakeClient(call), 'accounts.get', () => ({
        params: { accountId: 'a' },
      }))
    );

    expect(call).not.toHaveBeenCalled();
    await flush();
    await flush();

    expect(resource.value()).toEqual({ id: 'a', name: 'Account a' });
    expect(resource.result()?.status).toBe(200);
    expect(resource.failure()).toBeUndefined();
    expect(resource.metadata()).toBe(EMPTY_RESPONSE_METADATA);
    expect(resource.status()).toBe('resolved');
    expect(resource.isLoading()).toBe(false);
  });

  it('tracks input signals and aborts a stale load before it can publish', async () => {
    setup();
    const accountId = signal('a');
    let resolveFirst: ((result: AccountResult) => void) | undefined;
    const first = new Promise<AccountResult>(resolve => {
      resolveFirst = resolve;
    });
    const signals: AbortSignal[] = [];
    const client = fakeClient(async (input, options) => {
      signals.push(options?.signal as AbortSignal);
      return input.params.accountId === 'a' ? first : success(input.params.accountId);
    });
    const operation = TestBed.runInInjectionContext(() =>
      createOperationResource(client, 'accounts.get', () => ({
        params: { accountId: accountId() },
      }))
    );

    await flush();
    accountId.set('b');
    await flush();
    await flush();

    expect(signals[0]?.aborted).toBe(true);
    expect(operation.value()?.id).toBe('b');

    resolveFirst?.(success('a'));
    await flush();
    expect(operation.value()?.id).toBe('b');
  });

  it('keeps declared API failures as values instead of exceptional errors', async () => {
    setup();
    const failure: AccountResult = {
      ok: false,
      status: 404,
      error: {
        declared: true,
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
        details: { accountId: 'missing' },
        requestId: 'request-404',
      },
      headers: { headers: { 'x-request-id': 'request-404' }, requestId: 'request-404' },
    };
    const operation = TestBed.runInInjectionContext(() =>
      createOperationResource(
        fakeClient(async () => failure),
        'accounts.get',
        () => ({
          params: { accountId: 'missing' },
        })
      )
    );

    await flush();
    await flush();

    expect(operation.status()).toBe('resolved');
    expect(operation.value()).toBeUndefined();
    expect(operation.error()).toBeUndefined();
    expect(operation.failure()).toBe(failure);
    expect(operation.metadata()?.requestId).toBe('request-404');
  });

  it('surfaces exceptional failures without making value reads throw', async () => {
    setup();
    const networkError = new Error('network unavailable');
    const operation = TestBed.runInInjectionContext(() =>
      createOperationResource(
        fakeClient(async () => Promise.reject(networkError)),
        'accounts.get',
        () => ({ params: { accountId: 'a' } })
      )
    );

    await flush();
    await flush();

    expect(operation.status()).toBe('error');
    expect(operation.error()).toBe(networkError);
    expect(operation.value()).toBeUndefined();
    expect(operation.result()).toBeUndefined();
  });

  it('revalidates with ETags and preserves typed data on 304', async () => {
    setup();
    const receivedOptions: Array<OperationCallOptions | undefined> = [];
    let callNumber = 0;
    const client = fakeClient(async (_input, options) => {
      receivedOptions.push(options);
      callNumber += 1;
      return callNumber === 1
        ? success('a', 'version-1')
        : {
            ok: true,
            notModified: true,
            status: 304,
            headers: { headers: { etag: 'version-1' }, etag: 'version-1' },
          };
    });
    const operation = TestBed.runInInjectionContext(() =>
      createOperationResource(client, 'accounts.get', () => ({ params: { accountId: 'a' } }), {
        etag: { key: input => input.params.accountId },
      })
    );

    await flush();
    await flush();
    const original = operation.value();
    expect(operation.reload()).toBe(true);
    await flush();
    await flush();

    expect(receivedOptions[1]?.headers).toMatchObject({ 'if-none-match': 'version-1' });
    expect(operation.value()).toBe(original);
    expect(operation.result()).toMatchObject({ ok: true, notModified: true, status: 304 });
  });

  it('rejects a 304 response when no matching cached value exists', async () => {
    setup();
    const operation = TestBed.runInInjectionContext(() =>
      createOperationResource(
        fakeClient(async () => ({
          ok: true,
          notModified: true,
          status: 304,
          headers: EMPTY_RESPONSE_METADATA,
        })),
        'accounts.get',
        () => ({ params: { accountId: 'a' } }),
        { etag: { key: input => input.params.accountId } }
      )
    );

    await flush();
    await flush();

    expect(operation.error()).toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-status',
      status: 304,
    });
  });

  it('composes caller cancellation and destroys active work', async () => {
    setup();
    const caller = new AbortController();
    const observed: AbortSignal[] = [];
    const client = fakeClient(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          const requestSignal = options?.signal as AbortSignal;
          observed.push(requestSignal);
          requestSignal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const operation = TestBed.runInInjectionContext(() =>
      createOperationResource(client, 'accounts.get', () => ({ params: { accountId: 'a' } }), {
        call: { signal: caller.signal },
      })
    );

    await flush();
    caller.abort();
    await flush();
    expect(observed[0]?.aborted).toBe(true);

    operation.destroy();
    expect(operation.status()).toBe('idle');
  });

  it('stays idle while the input factory returns undefined', async () => {
    setup();
    const call = vi.fn(async () => success('a'));
    const operation = TestBed.runInInjectionContext(() =>
      createOperationResource(fakeClient(call), 'accounts.get', () => undefined)
    );

    await flush();
    expect(call).not.toHaveBeenCalled();
    expect(operation.status()).toBe('idle');
  });
});
