import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { ShipConsoleAppComponent } from './console-app.component';
import type { ShipConsoleCallResult } from './console-contract';
import { ShipConsoleCronPanelComponent } from './cron-panel.component';
import { ShipConsoleOutboxPanelComponent } from './outbox-panel.component';
import { injectConsole, provideShipConsole, SHIP_CONSOLE } from './provide-ship-console';
import { ShipConsoleRealtimePanelComponent } from './realtime-panel.component';
import { ShipConsoleWebhooksPanelComponent } from './webhooks-panel.component';

type Handler = (operation: string, input: unknown) => ShipConsoleCallResult;

function configure(handler: Handler) {
  const call = vi.fn(async (operation: string, input: unknown) => handler(operation, input));
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideShipConsole({ client: () => ({ call }) })],
  });
  return call;
}

const ok = (data: unknown): ShipConsoleCallResult => ({ ok: true, status: 200, data });
const buttons = (element: HTMLElement, label: string) =>
  [...element.querySelectorAll('button')].filter(b => b.textContent?.trim() === label);
const select = (element: HTMLElement, value: string) => {
  const node = element.querySelector('select') as HTMLSelectElement;
  node.value = value;
  node.dispatchEvent(new Event('change'));
};

describe('ShipConsoleAppComponent', () => {
  it('renders a router outlet as the standalone root', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(ShipConsoleAppComponent);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('router-outlet')).not.toBeNull();
  });
});

describe('provideShipConsole', () => {
  it('builds one console per injector from a client factory', () => {
    configure(() => ok({}));
    const console = TestBed.runInInjectionContext(() => injectConsole());
    expect(console).toBe(TestBed.inject(SHIP_CONSOLE));
    expect(console.operationId('panels')).toBe('console.panels');
  });
});

describe('ShipConsoleCronPanelComponent', () => {
  it('lists schedules and triggers one now', async () => {
    const call = configure(operation =>
      operation === 'console.cron.schedules'
        ? ok({
            schedules: [
              {
                jobId: 'reports.digest',
                trigger: { kind: 'schedule', cron: '0 6 * * *', tz: 'UTC' },
                nextAt: '2026-10-23T06:00:00.000Z',
                paused: false,
                reconciled: false,
              },
            ],
          })
        : ok({ jobId: 'reports.digest', runId: 'reports.digest/now', deduplicated: true })
    );
    const fixture = TestBed.createComponent(ShipConsoleCronPanelComponent);
    await fixture.componentInstance.reload();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('0 6 * * * (UTC)');
    expect(element.textContent).toContain('(not reconciled)');
    buttons(element, 'Trigger now')[0]?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.cron.trigger', {
      body: { jobId: 'reports.digest' },
    });
    expect(element.textContent).toContain('reports.digest/now');
    expect(element.textContent).toContain('(already queued)');
  });
});

describe('ShipConsoleWebhooksPanelComponent', () => {
  it('lists receipts, filters by endpoint, shows detail and replays', async () => {
    const receipts = {
      webhooks: [
        { id: 'payments.stripe', provider: 'stripe', path: '/webhooks/stripe', mode: 'enqueue' },
      ],
      capabilities: { list: true, dispatch: true, observed: true },
      receipts: [
        {
          eventId: 'evt-1',
          webhookId: 'payments.stripe',
          provider: 'stripe',
          providerEventId: 'evt_1',
          requestId: 'r1',
          receivedAt: '2026-10-22T10:00:00.000Z',
          bytes: 12,
          verification: 'verified',
          dispatch: {
            recordId: 'rec',
            outboxId: 'payments.outbox',
            intentId: 'process',
            status: 'dead-lettered',
            attempts: 3,
            lastError: 'sink down',
            availableAt: '2026-10-22T10:00:00.000Z',
          },
        },
      ],
      observed: [
        {
          webhookId: 'payments.stripe',
          provider: 'stripe',
          outcome: 'rejected',
          status: 401,
          reason: 'signature-mismatch',
          durationMs: 2,
          at: '2026-10-22T09:00:00.000Z',
        },
      ],
    };
    const call = configure(operation => {
      switch (operation) {
        case 'console.webhooks.receipts':
          return ok(receipts);
        case 'console.webhooks.receipt':
          return ok({
            receipt: {
              ...receipts.receipts[0],
              headers: { 'content-type': 'application/json', 'x-a': '1' },
              bodyText: '{"id":"evt_1"}',
            },
          });
        case 'console.webhooks.replay':
          return ok({ eventId: 'evt-1', webhookId: 'payments.stripe', queued: true });
        default:
          return ok({});
      }
    });
    const fixture = TestBed.createComponent(ShipConsoleWebhooksPanelComponent);
    await fixture.componentInstance.reload();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('evt_1');
    expect(element.textContent).toContain('dead-lettered (3 attempts)');
    expect(element.textContent).toContain('sink down');
    expect(element.textContent).toContain('rejected 401 (signature-mismatch)');

    select(element, 'payments.stripe');
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenLastCalledWith('console.webhooks.receipts', {
      query: { webhookId: 'payments.stripe', limit: 50 },
    });

    buttons(element, 'Detail')[0]?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(element.textContent).toContain('content-type: application/json');
    expect(element.querySelector('pre')?.textContent).toBe('{"id":"evt_1"}');

    buttons(element, 'Replay')[0]?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.webhooks.replay', { params: { eventId: 'evt-1' } });
    expect(element.textContent).toContain('Replayed evt-1: queued');

    select(element, '');
    await fixture.whenStable();
    expect(fixture.componentInstance.webhookId()).toBeUndefined();
  });

  it('explains a store that cannot list receipts and a body that is not previewable', async () => {
    configure(operation =>
      operation === 'console.webhooks.receipts'
        ? ok({
            webhooks: [],
            capabilities: { list: false, dispatch: false, observed: false },
            receipts: [],
            observed: [],
          })
        : ok({
            receipt: {
              eventId: 'evt-2',
              webhookId: 'w',
              provider: 'p',
              requestId: 'r',
              receivedAt: '2026-10-22T10:00:00.000Z',
              bytes: 70_000,
              verification: 'verified',
              headers: {},
            },
          })
    );
    const fixture = TestBed.createComponent(ShipConsoleWebhooksPanelComponent);
    await fixture.componentInstance.reload();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('does not list receipts');
    expect(element.textContent).toContain('No stored receipts');
    await fixture.componentInstance.console.loadReceipt('evt-2');
    await fixture.whenStable();
    expect(element.textContent).toContain('Body not previewable (70000 bytes)');
  });
});

describe('ShipConsoleRealtimePanelComponent', () => {
  it('renders backend health and channel counts, and notes a backend without introspection', async () => {
    configure(() =>
      ok({
        backend: { id: 'g1', adapter: 'socket.io-redis', ok: false, detail: 'not started' },
        capabilities: { introspection: false },
        channels: [{ channelId: 'reports.activity', scope: 'actor', presence: false }],
      })
    );
    const fixture = TestBed.createComponent(ShipConsoleRealtimePanelComponent);
    await fixture.componentInstance.console.loadRealtime();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('socket.io-redis unhealthy');
    expect(element.textContent).toContain('not started');
    expect(element.textContent).toContain('reports no subscriber counts');
    expect(element.textContent).toContain('reports.activity');
  });

  it('shows subscriber counts and the last publish when introspection exists', async () => {
    configure(() =>
      ok({
        backend: { id: 'm', adapter: 'memory', ok: true },
        capabilities: { introspection: true },
        channels: [
          {
            channelId: 'c',
            scope: 'tenant',
            presence: true,
            subscribers: 3,
            scopes: 2,
            lastPublishedAt: '2026-10-22T10:00:00.000Z',
            lastScopeKey: 'acme',
          },
        ],
      })
    );
    const fixture = TestBed.createComponent(ShipConsoleRealtimePanelComponent);
    await fixture.componentInstance.console.loadRealtime();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('memory ok');
    expect(element.textContent).toContain('2026-10-22 10:00:00 (acme)');
    expect(element.textContent).toContain('yes');
  });
});

describe('ShipConsoleOutboxPanelComponent', () => {
  it('lists outboxes, inspects records by status, retries and discards dead letters', async () => {
    const call = configure(operation => {
      switch (operation) {
        case 'console.outbox.overview':
          return ok({
            outboxes: [
              {
                outboxId: 'reports.outbox',
                intents: ['notify'],
                adapter: 'memory',
                pending: 1,
                claimed: 0,
                deadLettered: 1,
                oldestPendingAt: '2026-10-22T10:00:00.000Z',
                capabilities: { records: true },
              },
            ],
          });
        case 'console.outbox.records':
          return ok({
            outboxId: 'reports.outbox',
            records: [
              {
                id: 'rec-1',
                intentId: 'notify',
                status: 'dead-lettered',
                attempts: 5,
                payload: { to: 'a' },
                lastError: 'smtp',
                availableAt: '2026-10-22T10:00:00.000Z',
                createdAt: '2026-10-22T10:00:00.000Z',
              },
            ],
          });
        case 'console.outbox.retry':
          return ok({
            outboxId: 'reports.outbox',
            record: {
              id: 'rec-1',
              intentId: 'notify',
              status: 'pending',
              attempts: 5,
              availableAt: 'x',
              createdAt: 'x',
            },
          });
        case 'console.outbox.discard':
          return ok({
            outboxId: 'reports.outbox',
            record: {
              id: 'rec-1',
              intentId: 'notify',
              status: 'discarded',
              attempts: 5,
              availableAt: 'x',
              createdAt: 'x',
              discardReason: 'discarded from console',
            },
          });
        default:
          return ok({});
      }
    });
    const fixture = TestBed.createComponent(ShipConsoleOutboxPanelComponent);
    await fixture.componentInstance.console.loadOutboxes();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('reports.outbox');
    expect(element.textContent).toContain('notify');

    buttons(element, 'Records')[0]?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.outbox.records', {
      query: { outboxId: 'reports.outbox', status: 'dead-lettered', limit: 50 },
    });
    expect(element.textContent).toContain('smtp');

    buttons(element, 'Discard')[0]?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.outbox.discard', {
      body: { outboxId: 'reports.outbox', recordId: 'rec-1', reason: 'discarded from console' },
    });
    expect(element.textContent).toContain('discarded');

    await fixture.componentInstance.inspect('reports.outbox');
    await fixture.whenStable();
    buttons(element, 'Retry')[0]?.click();
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('console.outbox.retry', {
      body: { outboxId: 'reports.outbox', recordId: 'rec-1' },
    });

    select(element, 'pending');
    await fixture.whenStable();
    await fixture.whenStable();
    expect(call).toHaveBeenLastCalledWith('console.outbox.records', {
      query: { outboxId: 'reports.outbox', status: 'pending', limit: 50 },
    });
    select(element, 'bogus');
    await fixture.whenStable();
    expect(fixture.componentInstance.status()).toBe('pending');
  });
});
