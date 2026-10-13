import { describe, expect, it, vi } from 'vitest';
import { createOperationMutation } from './create-operation-mutation';
import type { OperationCallOptions, OperationClient } from './operation-client';
import { OperationMutationBusyError } from './operation-mutation-busy-error';
import type { OperationResultOf } from './operation-result';
import { EMPTY_RESPONSE_METADATA } from './response-metadata';

interface TestContract {
  readonly 'accounts.rename': {
    readonly input: {
      readonly params: { readonly accountId: string };
      readonly body: { readonly name: string };
    };
    readonly success: { readonly 200: { readonly id: string; readonly name: string } };
    readonly errors: 'ACCOUNT_NOT_FOUND' | 'VALIDATION_ERROR';
    readonly transport: 'http';
  };
}

type RenameInput = TestContract['accounts.rename']['input'];
type RenameResult = OperationResultOf<TestContract, 'accounts.rename'>;

function fakeClient(
  handler: (input: RenameInput, options: OperationCallOptions | undefined) => Promise<RenameResult>
): OperationClient<TestContract> {
  return {
    call: ((_operation, input, options) =>
      handler(input, options)) as OperationClient<TestContract>['call'],
  };
}

function input(name: string): RenameInput {
  return { params: { accountId: 'account-1' }, body: { name } };
}

function success(name: string): RenameResult {
  return {
    ok: true,
    status: 200,
    data: { id: 'account-1', name },
    headers: EMPTY_RESPONSE_METADATA,
  };
}

function failure(): RenameResult {
  return {
    ok: false,
    status: 422,
    error: {
      declared: true,
      code: 'VALIDATION_ERROR',
      message: 'Name is invalid',
      details: { issues: [] },
    },
    headers: EMPTY_RESPONSE_METADATA,
  };
}

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

describe('createOperationMutation', () => {
  it('honors caller cancellation before optimistic work and during execution', async () => {
    const caller = new AbortController();
    caller.abort();
    const call = vi.fn(async () => success('saved'));
    const apply = vi.fn(() => 'snapshot');
    const mutation = createOperationMutation(fakeClient(call), 'accounts.rename', {
      call: { signal: caller.signal },
      optimistic: { apply, rollback: vi.fn() },
    });
    await expect(mutation.execute(input('saved'))).rejects.toMatchObject({
      name: 'OperationAbortedError',
    });
    expect(call).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(mutation.status()).toBe('aborted');
    const pending = new AbortController();
    const rollback = vi.fn();
    const active = createOperationMutation(
      fakeClient(async (_input, options) => {
        pending.abort();
        expect(options?.signal?.aborted).toBe(true);
        return success('saved');
      }),
      'accounts.rename',
      {
        call: () => ({ signal: pending.signal }),
        optimistic: { apply, rollback },
      }
    );
    await expect(active.execute(input('saved'))).rejects.toMatchObject({
      name: 'OperationAbortedError',
    });
    expect(rollback).toHaveBeenCalledOnce();
  });
  it('publishes success state and resolves the complete operation result', async () => {
    const received: Array<OperationCallOptions | undefined> = [];
    const mutation = createOperationMutation(
      fakeClient(async (_input, options) => {
        received.push(options);
        return success('Ada');
      }),
      'accounts.rename',
      { call: value => ({ idempotencyKey: `rename-${value.body.name}` }) }
    );

    const result = await mutation.execute(input('Ada'));

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(received[0]?.idempotencyKey).toBe('rename-Ada');
    expect(received[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(mutation.status()).toBe('success');
    expect(mutation.pending()).toBe(false);
    expect(mutation.input()).toEqual(input('Ada'));
    expect(mutation.result()).toBe(result);
    expect(mutation.data()).toEqual({ id: 'account-1', name: 'Ada' });
    expect(mutation.failure()).toBeUndefined();
    expect(mutation.error()).toBeUndefined();

    mutation.reset();
    expect(mutation.status()).toBe('idle');
    expect(mutation.result()).toBeUndefined();
  });

  it('passes an opted-in keepalive flag to the client and omits it by default', async () => {
    const received: Array<OperationCallOptions | undefined> = [];
    const client = fakeClient(async (_input, options) => {
      received.push(options);
      return success('Ada');
    });
    const plain = createOperationMutation(client, 'accounts.rename');
    const keepalive = createOperationMutation(client, 'accounts.rename', {
      call: { keepalive: true },
    });

    await plain.execute(input('Ada'));
    await keepalive.execute(input('Ada'));

    expect(received[0]).not.toHaveProperty('keepalive');
    expect(received[1]).toMatchObject({ keepalive: true });
    expect(received[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rolls back optimistic state and resolves declared API failures as values', async () => {
    const apply = vi.fn(() => undefined);
    const rollback = vi.fn();
    const mutation = createOperationMutation(
      fakeClient(async () => failure()),
      'accounts.rename',
      {
        optimistic: { apply, rollback },
      }
    );

    const result = await mutation.execute(input(''));

    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(apply).toHaveBeenCalledWith(input(''));
    expect(rollback).toHaveBeenCalledWith(undefined, result);
    expect(mutation.status()).toBe('failure');
    expect(mutation.failure()).toBe(result);
    expect(mutation.data()).toBeUndefined();
    expect(mutation.error()).toBeUndefined();
  });

  it('reconciles an optimistic update after a successful response', async () => {
    const reconcile = vi.fn();
    const rollback = vi.fn();
    const mutation = createOperationMutation(
      fakeClient(async () => success('Server')),
      'accounts.rename',
      {
        optimistic: {
          apply: () => ({ previousName: 'Old' }),
          rollback,
          reconcile,
        },
      }
    );

    await mutation.execute(input('Client'));

    expect(reconcile).toHaveBeenCalledWith(
      { previousName: 'Old' },
      { id: 'account-1', name: 'Server' }
    );
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back and rejects exceptional failures', async () => {
    const rollback = vi.fn();
    const networkError = new Error('network unavailable');
    const mutation = createOperationMutation(
      fakeClient(async () => Promise.reject(networkError)),
      'accounts.rename',
      {
        optimistic: {
          apply: () => ({ previousName: 'Old' }),
          rollback,
        },
      }
    );

    await expect(mutation.execute(input('New'))).rejects.toBe(networkError);
    expect(rollback).toHaveBeenCalledWith({ previousName: 'Old' }, networkError);
    expect(mutation.status()).toBe('error');
    expect(mutation.error()).toBe(networkError);
  });

  it('rejects overlap and reset while the default mutation is pending', async () => {
    const pendingResult = deferred<RenameResult>();
    const mutation = createOperationMutation(
      fakeClient(async () => pendingResult.promise),
      'accounts.rename'
    );
    const pending = mutation.execute(input('First'));

    await expect(mutation.execute(input('Second'))).rejects.toBeInstanceOf(
      OperationMutationBusyError
    );
    expect(() => mutation.reset()).toThrow(OperationMutationBusyError);
    expect(mutation.pending()).toBe(true);

    pendingResult.resolve(success('First'));
    await pending;
  });

  it('aborts a stale take-latest call without letting it overwrite the latest state', async () => {
    const firstResult = deferred<RenameResult>();
    const mutation = createOperationMutation(
      fakeClient(async value =>
        value.body.name === 'First' ? firstResult.promise : success(value.body.name)
      ),
      'accounts.rename',
      { concurrency: 'take-latest' }
    );

    const first = mutation.execute(input('First'));
    const second = mutation.execute(input('Second'));
    await expect(second).resolves.toMatchObject({ ok: true, status: 200 });

    firstResult.resolve(success('First'));
    await expect(first).rejects.toMatchObject({ name: 'OperationAbortedError' });
    expect(mutation.status()).toBe('success');
    expect(mutation.data()?.name).toBe('Second');
  });

  it('cancels active transport work and distinguishes the aborted state', async () => {
    const mutation = createOperationMutation(
      fakeClient(
        (_input, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException()), {
              once: true,
            });
          })
      ),
      'accounts.rename'
    );
    const pending = mutation.execute(input('Ada'));

    expect(mutation.cancel()).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'OperationAbortedError' });
    expect(mutation.status()).toBe('aborted');
    expect(mutation.cancel()).toBe(false);
  });

  it('treats a mutation 304 as a protocol failure', async () => {
    const mutation = createOperationMutation(
      fakeClient(async () => ({
        ok: true,
        notModified: true,
        status: 304,
        headers: EMPTY_RESPONSE_METADATA,
      })),
      'accounts.rename'
    );

    await expect(mutation.execute(input('Ada'))).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-status',
      status: 304,
    });
    expect(mutation.status()).toBe('error');
  });

  it('rejects the rollback-unsafe combination of optimistic and take-latest behavior', () => {
    expect(() =>
      createOperationMutation(
        fakeClient(async () => success('Ada')),
        'accounts.rename',
        {
          concurrency: 'take-latest',
          optimistic: { apply: () => undefined, rollback: () => undefined },
        }
      )
    ).toThrow('Optimistic mutations cannot use take-latest concurrency');
  });

  it('surfaces both the operation error and a rollback error', async () => {
    const mutation = createOperationMutation(
      fakeClient(async () => Promise.reject('non-error failure')),
      'accounts.rename',
      {
        optimistic: {
          apply: () => 'snapshot',
          rollback: () => Promise.reject(new Error('rollback failed')),
        },
      }
    );

    await expect(mutation.execute(input('Ada'))).rejects.toMatchObject({
      name: 'OperationMutationRollbackError',
      message: 'Operation mutation and optimistic rollback both failed',
      operationError: expect.objectContaining({
        message: 'Operation mutation failed with a non-Error value',
      }),
      rollbackError: expect.objectContaining({ message: 'rollback failed' }),
    });
    expect(mutation.status()).toBe('error');
  });

  it('retains a declared API failure when its optimistic rollback also fails', async () => {
    const mutation = createOperationMutation(
      fakeClient(async () => failure()),
      'accounts.rename',
      {
        optimistic: {
          apply: () => 'snapshot',
          rollback: () => Promise.reject(new Error('rollback failed')),
        },
      }
    );

    await expect(mutation.execute(input('Ada'))).rejects.toMatchObject({
      name: 'OperationMutationRollbackError',
      message: 'Operation failure and optimistic rollback both failed',
      operationError: expect.objectContaining({
        name: 'OperationApiError',
        code: 'VALIDATION_ERROR',
        status: 422,
      }),
      rollbackError: expect.objectContaining({ message: 'rollback failed' }),
    });
  });
});
