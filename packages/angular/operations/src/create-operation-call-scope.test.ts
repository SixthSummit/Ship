import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationCallScope } from './create-operation-call-scope';
import { OperationAbortedError } from './operation-aborted-error';
import { OperationTimeoutError } from './operation-timeout-error';

afterEach(() => {
  vi.useRealTimers();
});

describe('createOperationCallScope', () => {
  it('combines caller and transport cancellation', () => {
    const caller = new AbortController();
    const transport = new AbortController();
    const scope = createOperationCallScope([caller.signal, transport.signal]);

    transport.abort();

    expect(scope.signal.aborted).toBe(true);
    expect(scope.abortError()).toBeInstanceOf(OperationAbortedError);
    expect(() => scope.throwIfAborted()).toThrow(OperationAbortedError);
    scope.cleanup();
  });

  it('recognizes a source that was already aborted', () => {
    const caller = new AbortController();
    caller.abort();

    const scope = createOperationCallScope([caller.signal]);

    expect(() => scope.throwIfAborted()).toThrow(OperationAbortedError);
    scope.cleanup();
  });

  it('distinguishes a timeout from ordinary cancellation', () => {
    vi.useFakeTimers();
    const scope = createOperationCallScope([], 25);

    vi.advanceTimersByTime(25);

    expect(scope.abortError()).toBeInstanceOf(OperationTimeoutError);
    expect(() => scope.throwIfAborted()).toThrow(OperationTimeoutError);
    scope.cleanup();
  });

  it('clears the deadline during cleanup', () => {
    vi.useFakeTimers();
    const scope = createOperationCallScope([], 25);

    scope.cleanup();
    vi.advanceTimersByTime(25);

    expect(scope.signal.aborted).toBe(false);
    expect(scope.abortError()).toBeUndefined();
  });
});
