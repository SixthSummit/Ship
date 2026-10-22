import { describe, expect, it, vi } from 'vitest';
import type { ShipConsoleCallResult, ShipConsoleClient } from './console-contract';
import { ShipConsole } from './ship-console';

function fakeClient(handler: (operation: string, input: unknown) => ShipConsoleCallResult) {
  const calls: { operation: string; input: unknown }[] = [];
  const client: ShipConsoleClient = {
    call: vi.fn(async (operation: string, input: unknown) => {
      calls.push({ operation, input });
      return handler(operation, input);
    }),
  };
  return { client, calls };
}

const ok = (data: unknown): ShipConsoleCallResult => ({ ok: true, status: 200, data });
const failed = (status: number, code: string): ShipConsoleCallResult => ({
  ok: false,
  status,
  error: { code, message: `${code} happened` },
});

describe('ShipConsole', () => {
  it('calls every operation under the configured prefix and keeps the latest panel state', async () => {
    const { client, calls } = fakeClient(operation => {
      switch (operation) {
        case 'ops.panels':
          return ok({ id: 'ops', basePath: '/ops', permission: 'console.operate', panels: [] });
        case 'ops.jobs.overview':
          return ok({
            capabilities: { adapter: 'memory', runs: true, schedules: true, pause: true },
            jobs: [
              {
                jobId: 'a',
                declared: true,
                waiting: 0,
                active: 0,
                delayed: 0,
                failed: 1,
                lagMs: 0,
                paused: false,
              },
            ],
          });
        case 'ops.jobs.runs':
          return ok({
            runs: [
              {
                runId: 'r1',
                jobId: 'a',
                status: 'failed',
                attempts: 1,
                history: [],
                createdAt: 'x',
                availableAt: 'x',
              },
            ],
          });
        case 'ops.jobs.retry':
          return ok({
            run: {
              runId: 'r1',
              jobId: 'a',
              status: 'waiting',
              attempts: 1,
              history: [],
              createdAt: 'x',
              availableAt: 'x',
            },
          });
        case 'ops.jobs.pause':
          return ok({ jobId: 'a', paused: true });
        case 'ops.cron.schedules':
          return ok({
            schedules: [
              {
                jobId: 'a',
                trigger: { kind: 'interval', everyMs: 5 },
                paused: false,
                reconciled: true,
              },
            ],
          });
        case 'ops.jobs.retry-all':
          return ok({ retried: 2, runIds: ['r1', 'r2'] });
        case 'ops.outbox.records':
          return ok({
            outboxId: 'o',
            records: [
              {
                id: 'rec',
                intentId: 'i',
                status: 'dead-lettered',
                attempts: 1,
                availableAt: 'x',
                createdAt: 'x',
              },
            ],
          });
        case 'ops.outbox.retry':
          return ok({
            outboxId: 'o',
            record: {
              id: 'rec',
              intentId: 'i',
              status: 'pending',
              attempts: 1,
              availableAt: 'x',
              createdAt: 'x',
            },
          });
        default:
          return ok({});
      }
    });
    const console = new ShipConsole({ client: () => client, prefix: 'ops' });
    expect(console.operationId('jobs.retry')).toBe('ops.jobs.retry');

    await console.loadPanels();
    expect(console.panels()?.basePath).toBe('/ops');
    await console.loadJobs();
    expect(console.jobs()?.jobs[0]?.failed).toBe(1);
    await console.loadRuns({ status: 'failed', jobId: undefined });
    expect(calls.at(-1)).toEqual({
      operation: 'ops.jobs.runs',
      input: { query: { status: 'failed' } },
    });
    expect(console.runs()).toHaveLength(1);
    await console.retry('r1');
    expect(console.runs()[0]?.status).toBe('waiting');
    await console.loadSchedules();
    await console.pause('a');
    expect(console.jobs()?.jobs[0]?.paused).toBe(true);
    expect(console.schedules()[0]?.paused).toBe(true);
    expect(await console.retryAll('a')).toBe(2);
    expect(calls.at(-1)).toEqual({
      operation: 'ops.jobs.retry-all',
      input: { body: { jobId: 'a' } },
    });
    await console.loadOutboxRecords('o', 'dead-lettered');
    await console.retryRecord('o', 'rec');
    expect(console.outboxRecords()?.records[0]?.status).toBe('pending');
    expect(console.failure()).toBeUndefined();
    expect(console.busy()).toBe(false);
  });

  it('keeps declared failures and transport errors as values', async () => {
    const { client } = fakeClient(operation =>
      operation === 'console.jobs.overview' ? failed(403, 'AUTHORIZATION_ERROR') : ok({})
    );
    const console = new ShipConsole({ client });
    expect(await console.loadJobs()).toBeUndefined();
    expect(console.failure()).toEqual({
      operation: 'console.jobs.overview',
      status: 403,
      code: 'AUTHORIZATION_ERROR',
      message: 'AUTHORIZATION_ERROR happened',
    });
    await console.loadPanels();
    expect(console.failure()).toBeUndefined();
    console.clearFailure();

    const throwing = new ShipConsole({
      client: {
        call: async () => {
          throw new Error('offline');
        },
      },
    });
    expect(await throwing.loadRealtime()).toBeUndefined();
    expect(throwing.failure()).toMatchObject({
      code: 'TRANSPORT_ERROR',
      message: 'offline',
      status: 0,
    });
    expect(throwing.busy()).toBe(false);

    const notModified = new ShipConsole({
      client: { call: async () => ({ ok: true, status: 304, notModified: true }) },
    });
    expect(await notModified.loadOutboxes()).toBeUndefined();
  });
});
