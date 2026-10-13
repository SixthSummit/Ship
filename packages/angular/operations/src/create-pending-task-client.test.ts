import { describe, expect, it, vi } from 'vitest';
import { createPendingTaskClient } from './create-pending-task-client';
import type { OperationClient } from './operation-client';

interface TestContract {
  readonly 'status.get': {
    readonly input: Record<string, never>;
    readonly success: { readonly 200: { readonly ready: boolean } };
    readonly errors: 'UNAVAILABLE';
    readonly transport: 'http';
  };
}

function fakePendingTasks(): {
  readonly add: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return { add: vi.fn(() => release), release };
}

describe('createPendingTaskClient', () => {
  it('holds one task across the delegated call and forwards every argument', async () => {
    const tasks = fakePendingTasks();
    const call = vi.fn(async () => {
      expect(tasks.add).toHaveBeenCalledTimes(1);
      expect(tasks.release).not.toHaveBeenCalled();
      return { ok: true, status: 200, data: { ready: true }, headers: { headers: {} } };
    }) as unknown as OperationClient<TestContract>['call'];
    const client = createPendingTaskClient<TestContract>({ call }, tasks);
    const options = { keepalive: true };

    await expect(client.call('status.get', {}, options)).resolves.toMatchObject({ ok: true });

    expect(call).toHaveBeenCalledWith('status.get', {}, options);
    expect(tasks.release).toHaveBeenCalledTimes(1);
  });

  it('releases the task when the delegated call rejects', async () => {
    const tasks = fakePendingTasks();
    const failure = new Error('transport down');
    const client = createPendingTaskClient<TestContract>(
      { call: (async () => Promise.reject(failure)) as OperationClient<TestContract>['call'] },
      tasks
    );

    await expect(client.call('status.get', {})).rejects.toBe(failure);

    expect(tasks.add).toHaveBeenCalledTimes(1);
    expect(tasks.release).toHaveBeenCalledTimes(1);
  });
});
