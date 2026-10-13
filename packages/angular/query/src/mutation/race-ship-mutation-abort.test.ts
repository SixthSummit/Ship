import { OperationAbortedError } from '@sixthsummit/ship-angular/operations';
import { describe, expect, it, vi } from 'vitest';
import { raceShipMutationAbort } from './race-ship-mutation-abort';

describe('raceShipMutationAbort', () => {
  it('does not invoke work that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(() => 'value');
    await expect(raceShipMutationAbort(run, controller.signal)).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves synchronous failures and removes its abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const original = new Error('failed synchronously');
    await expect(
      raceShipMutationAbort(() => {
        throw original;
      }, controller.signal)
    ).rejects.toBe(original);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
