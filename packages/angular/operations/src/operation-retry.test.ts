import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationAbortedError } from './operation-aborted-error';
import type { OperationExecutionPolicy } from './operation-policy';
import {
  abortableOperationDelay,
  operationRetryDelay,
  shouldRetryOperationResponse,
} from './operation-retry';

const safePolicy: OperationExecutionPolicy = {
  authentication: 'optional',
  safety: 'safe',
  idempotency: 'unsupported',
  replayable: true,
  retry: { maxAttempts: 3, statuses: [429, 503] },
};

const mutationPolicy: OperationExecutionPolicy = {
  authentication: 'required',
  safety: 'unsafe',
  idempotency: 'supported',
  replayable: true,
  retry: { maxAttempts: 2, statuses: [503] },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('operation retry policy', () => {
  it('retries only declared statuses within the attempt limit', () => {
    expect(shouldRetryOperationResponse({ ok: false, status: 503 }, safePolicy, undefined, 1)).toBe(
      true
    );
    expect(shouldRetryOperationResponse({ ok: false, status: 500 }, safePolicy, undefined, 1)).toBe(
      false
    );
    expect(shouldRetryOperationResponse({ ok: false, status: 503 }, safePolicy, undefined, 3)).toBe(
      false
    );
    expect(shouldRetryOperationResponse({ ok: true, status: 200 }, safePolicy, undefined, 1)).toBe(
      false
    );
  });

  it('never retries authentication or authorization denials', () => {
    const permissive: OperationExecutionPolicy = {
      ...safePolicy,
      retry: { maxAttempts: 3, statuses: [401, 403] },
    };
    expect(shouldRetryOperationResponse({ ok: false, status: 401 }, permissive, undefined, 1)).toBe(
      false
    );
    expect(shouldRetryOperationResponse({ ok: false, status: 403 }, permissive, undefined, 1)).toBe(
      false
    );
  });

  it('requires a replayable idempotent mutation and a caller key', () => {
    expect(
      shouldRetryOperationResponse({ ok: false, status: 503 }, mutationPolicy, 'key-1', 1)
    ).toBe(true);
    expect(
      shouldRetryOperationResponse({ ok: false, status: 503 }, mutationPolicy, undefined, 1)
    ).toBe(false);
    expect(
      shouldRetryOperationResponse(
        { ok: false, status: 503 },
        { ...mutationPolicy, replayable: false },
        'key-1',
        1
      )
    ).toBe(false);
  });

  it('uses Retry-After or capped exponential backoff', () => {
    expect(operationRetryDelay(1_200, 2)).toBe(1_200);
    expect(operationRetryDelay(undefined, 1)).toBe(250);
    expect(operationRetryDelay(undefined, 3, { baseDelayMs: 100, maxDelayMs: 250 })).toBe(250);
  });

  it('resolves an elapsed delay and rejects an aborted delay', async () => {
    vi.useFakeTimers();
    const completed = abortableOperationDelay(10, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10);
    await expect(completed).resolves.toBeUndefined();

    const controller = new AbortController();
    const aborted = abortableOperationDelay(10, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(OperationAbortedError);
    await expect(abortableOperationDelay(10, AbortSignal.abort())).rejects.toBeInstanceOf(
      OperationAbortedError
    );
  });
});
