import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { ShipConsoleCallResult } from './console-contract';
import { ShipConsoleJobsPanelComponent } from './jobs-panel.component';
import { provideShipConsole } from './provide-ship-console';

const overview = {
  capabilities: { adapter: 'memory', runs: true, schedules: true, pause: true },
  jobs: [
    {
      jobId: 'reports.render',
      declared: true,
      trigger: { kind: 'enqueue' },
      waiting: 1,
      active: 0,
      delayed: 0,
      failed: 2,
      lagMs: 10,
      paused: false,
    },
  ],
};
const runs = {
  runs: [
    {
      runId: 'reports.render/1',
      jobId: 'reports.render',
      status: 'failed',
      attempts: 1,
      history: [],
      createdAt: '2026-10-22T12:00:00.000Z',
      availableAt: '2026-10-22T12:00:00.000Z',
      lastError: 'boom',
      input: { tenantId: 'acme' },
    },
  ],
};

describe('ShipConsoleJobsPanelComponent', () => {
  it('renders the overview and runs, and retries a failed run through the console', async () => {
    const call = vi.fn(async (operation: string): Promise<ShipConsoleCallResult> => {
      switch (operation) {
        case 'console.jobs.overview':
          return { ok: true, status: 200, data: overview };
        case 'console.jobs.runs':
          return { ok: true, status: 200, data: runs };
        case 'console.jobs.retry':
          return { ok: true, status: 200, data: { run: { ...runs.runs[0], status: 'waiting' } } };
        case 'console.jobs.discard':
          return { ok: true, status: 200, data: { run: { ...runs.runs[0], status: 'discarded' } } };
        case 'console.jobs.retry-all':
          return { ok: true, status: 200, data: { retried: 1, runIds: ['reports.render/1'] } };
        default:
          return { ok: true, status: 200, data: {} };
      }
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideShipConsole({ client: { call } })],
    });
    const fixture = TestBed.createComponent(ShipConsoleJobsPanelComponent);
    await fixture.whenStable();
    await fixture.componentInstance.reload();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('reports.render');
    expect(element.textContent).toContain('adapter: memory');
    expect(element.textContent).toContain('boom');
    expect(call).toHaveBeenCalledWith('console.jobs.runs', {
      query: { status: 'failed', limit: 50 },
    });

    const retry = [...element.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Retry'
    );
    retry?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.jobs.retry', {
      body: { runId: 'reports.render/1' },
    });
    expect(element.textContent).toContain('waiting');

    const pause = [...element.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Pause'
    );
    pause?.click();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.jobs.pause', { body: { jobId: 'reports.render' } });
    const runsFor = [...element.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Runs'
    );
    runsFor?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenLastCalledWith('console.jobs.runs', {
      query: { jobId: 'reports.render', status: 'failed', limit: 50 },
    });
    expect(element.textContent).toContain('for reports.render');
    const allJobs = [...element.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'All jobs'
    );
    allJobs?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(fixture.componentInstance.jobId()).toBeUndefined();

    const status = element.querySelector('select') as HTMLSelectElement;
    status.value = 'completed';
    status.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenLastCalledWith('console.jobs.runs', {
      query: { status: 'completed', limit: 50 },
    });
    status.value = 'nope';
    status.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(fixture.componentInstance.status()).toBe('completed');

    const retryAll = [...element.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Retry all'
    );
    retryAll?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.jobs.retry-all', {
      body: { jobId: 'reports.render' },
    });

    await fixture.componentInstance.showRuns('reports.render');
    fixture.componentInstance.status.set('failed');
    await fixture.componentInstance.reload();
    await fixture.whenStable();
    const discard = [...element.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Discard'
    );
    discard?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.jobs.discard', {
      body: { runId: 'reports.render/1', reason: 'discarded from console' },
    });
  });
});
