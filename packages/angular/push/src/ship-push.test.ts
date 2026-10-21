import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  provideZonelessChangeDetection,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { BehaviorSubject, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { injectPush, provideShipPush, SHIP_PUSH } from './provide-ship-push';
import type { PushNotificationClick } from './push-subscription';
import { ShipPush } from './ship-push';

const serialized = {
  endpoint: 'https://push.example.test/secret',
  expirationTime: null,
  keys: { p256dh: 'browser-key', auth: 'auth-secret' },
};
const browserSubscription = { toJSON: () => serialized } as PushSubscription;

function setup(initial: PushSubscription | null = null) {
  const subscriptions = new BehaviorSubject(initial);
  const messages = new Subject<object>();
  const clicks = new Subject<PushNotificationClick>();
  const changes = new Subject<{
    newSubscription: PushSubscription | null;
    oldSubscription: PushSubscription | null;
  }>();
  const requestSubscription = vi.fn(async () => browserSubscription);
  const unsubscribe = vi.fn(async () => undefined);
  const options = {
    serverPublicKey: 'public-only',
    saveSubscription: vi.fn(async () => undefined),
    removeSubscription: vi.fn(async () => undefined),
  };
  const sw = {
    isEnabled: true,
    subscription: subscriptions,
    messages,
    notificationClicks: clicks,
    pushSubscriptionChanges: changes,
    requestSubscription,
    unsubscribe,
  } as unknown as SwPush;
  const client = new ShipPush(sw, options);
  return {
    client,
    sw,
    options,
    subscriptions,
    messages,
    clicks,
    changes,
    requestSubscription,
    unsubscribe,
  };
}

describe('ShipPush', () => {
  it('does not revoke a replacement subscription while removing an older server record', async () => {
    const { client, options, changes, unsubscribe } = setup(browserSubscription);
    let finish!: () => void;
    options.removeSubscription.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const pending = client.unsubscribe();
    const rotated = { ...serialized, endpoint: 'https://push.example.test/replacement' };
    changes.next({
      oldSubscription: browserSubscription,
      newSubscription: { toJSON: () => rotated } as PushSubscription,
    });
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'subscription-changed' });
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(client.subscription()).toEqual(rotated);
    await client.unsubscribe();
    expect(options.removeSubscription).toHaveBeenLastCalledWith(
      rotated,
      expect.objectContaining({ aborted: false })
    );
  });
  it('aborts in-flight persistence when destroyed and does not report late success', async () => {
    const { client, options } = setup();
    let finish!: () => void;
    options.saveSubscription.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const pending = client.subscribe();
    await Promise.resolve();
    const signal = options.saveSubscription.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    client.destroy();
    expect(signal?.aborted).toBe(true);
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
  });

  it('redacts worker lookup failures without producing unhandled observable errors', () => {
    const { client, subscriptions } = setup();
    subscriptions.error(new Error('secret worker failure'));
    expect(client.ready()).toBe(false);
    expect(client.error()?.code).toBe('subscription-failed');
    expect(client.error()?.message).not.toContain('secret');
    client.destroy();
  });
  it('supports Angular 20 workers without the newer rotation event stream', async () => {
    const { sw, options } = setup(browserSubscription);
    const client = new ShipPush(
      { ...sw, pushSubscriptionChanges: undefined } as unknown as SwPush,
      options
    );
    await client.sync();
    expect(options.saveSubscription).toHaveBeenCalledWith(
      serialized,
      expect.objectContaining({ aborted: false })
    );
    client.destroy();
  });
  it('does not prompt or persist until subscribe is called; saves browser credentials', async () => {
    const { client, requestSubscription, options } = setup();
    expect(requestSubscription).not.toHaveBeenCalled();
    expect(options.saveSubscription).not.toHaveBeenCalled();
    expect(client.ready()).toBe(true);
    expect(client.subscribed()).toBe(false);
    const pending = client.subscribe();
    expect(requestSubscription).toHaveBeenCalledWith({ serverPublicKey: 'public-only' });
    expect(client.busy()).toBe(true);
    await expect(pending).resolves.toEqual(serialized);
    expect(options.saveSubscription).toHaveBeenCalledWith(
      serialized,
      expect.objectContaining({ aborted: false })
    );
    expect(client.subscription()).toEqual(serialized);
    expect(client.subscribed()).toBe(true);
    expect(client.busy()).toBe(false);
  });

  it('retains a subscription after failed persistence so sync can retry without another prompt', async () => {
    const { client, options, requestSubscription } = setup();
    options.saveSubscription.mockRejectedValueOnce(new Error('secret backend response'));
    await expect(client.subscribe()).rejects.toMatchObject({ code: 'persistence-failed' });
    expect(client.error()?.message).not.toContain('secret');
    expect(client.subscribed()).toBe(true);
    await client.sync();
    expect(options.saveSubscription).toHaveBeenCalledTimes(2);
    expect(requestSubscription).toHaveBeenCalledOnce();
    expect(client.error()).toBeUndefined();
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['UnknownError', 'subscription-failed'],
  ])('reports %s without persisting or exposing provider messages', async (name, code) => {
    const { client, requestSubscription, options } = setup();
    requestSubscription.mockRejectedValueOnce(new DOMException('credential', name));
    await expect(client.subscribe()).rejects.toMatchObject({ code });
    expect(client.error()?.message).not.toContain('credential');
    expect(options.saveSubscription).not.toHaveBeenCalled();
    expect(client.busy()).toBe(false);
  });

  it('syncs restored and rotated subscriptions only on explicit request', async () => {
    const { client, options, changes, subscriptions } = setup(browserSubscription);
    expect(client.subscription()).toEqual(serialized);
    expect(options.saveSubscription).not.toHaveBeenCalled();
    await client.sync();
    const rotated = { ...serialized, endpoint: 'https://push.example.test/rotated' };
    changes.next({
      oldSubscription: browserSubscription,
      newSubscription: { toJSON: () => rotated } as PushSubscription,
    });
    expect(client.subscription()).toEqual(rotated);
    expect(options.saveSubscription).toHaveBeenCalledTimes(1);
    await client.sync();
    expect(options.saveSubscription).toHaveBeenLastCalledWith(
      rotated,
      expect.objectContaining({ aborted: false })
    );
    changes.next({ oldSubscription: browserSubscription, newSubscription: null });
    expect(client.subscription()).toBeNull();
    subscriptions.next(null);
    await client.sync();
    expect(options.saveSubscription).toHaveBeenCalledTimes(2);
  });

  it('removes server ownership before local unsubscription and allows safe retries', async () => {
    const { client, options, unsubscribe } = setup(browserSubscription);
    options.removeSubscription.mockRejectedValueOnce(new Error('backend failure'));
    await expect(client.unsubscribe()).rejects.toMatchObject({ code: 'persistence-failed' });
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(client.subscribed()).toBe(true);
    unsubscribe.mockRejectedValueOnce(new Error('browser failure'));
    await expect(client.unsubscribe()).rejects.toMatchObject({ code: 'subscription-failed' });
    expect(client.subscribed()).toBe(true);
    await client.unsubscribe();
    expect(client.subscribed()).toBe(false);
    expect(options.removeSubscription).toHaveBeenCalledTimes(3);
    await client.unsubscribe();
    expect(options.removeSubscription).toHaveBeenCalledTimes(3);
  });

  it('rejects overlapping actions and stops persistence if destroyed during permission request', async () => {
    const { client, requestSubscription, options } = setup();
    let finish!: (value: PushSubscription) => void;
    requestSubscription.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const pending = client.subscribe();
    await expect(client.sync()).rejects.toMatchObject({ code: 'busy' });
    await expect(client.unsubscribe()).rejects.toMatchObject({ code: 'busy' });
    client.destroy();
    finish(browserSubscription);
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    expect(options.saveSubscription).not.toHaveBeenCalled();
    await expect(client.subscribe()).rejects.toMatchObject({ code: 'closed' });
  });

  it('exposes messages and clicks as signals, then detaches without revoking on destroy', () => {
    const { client, messages, clicks, unsubscribe } = setup(browserSubscription);
    const click = { action: 'open', notification: { title: 'Hello', data: { url: '/inbox' } } };
    messages.next({ id: '1' });
    clicks.next(click);
    expect(client.latestMessage()).toEqual({ id: '1' });
    expect(client.latestClick()).toEqual(click);
    client.destroy();
    expect(messages.observed).toBe(false);
    expect(clicks.observed).toBe(false);
    expect(client.latestMessage()).toBeUndefined();
    expect(client.latestClick()).toBeUndefined();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('reports malformed browser credentials on initialization, rotation, and explicit subscription', async () => {
    const malformed = { toJSON: () => ({ endpoint: 'missing-keys' }) } as PushSubscription;
    const { client, changes, requestSubscription } = setup(malformed);
    expect(client.error()?.code).toBe('subscription-failed');
    changes.next({ oldSubscription: null, newSubscription: malformed });
    expect(client.error()?.code).toBe('subscription-failed');
    requestSubscription.mockResolvedValueOnce(malformed);
    await expect(client.subscribe()).rejects.toMatchObject({ code: 'subscription-failed' });
  });

  it('does not silently skip unsubscribe or sync before the worker responds', async () => {
    const { sw, options } = setup();
    const client = new ShipPush(
      { ...sw, subscription: new Subject() } as unknown as SwPush,
      options
    );
    expect(client.ready()).toBe(false);
    await expect(client.unsubscribe()).rejects.toMatchObject({ code: 'not-ready' });
    await expect(client.sync()).rejects.toMatchObject({ code: 'not-ready' });
    client.destroy();
  });
});

describe('Angular provider boundary', () => {
  it('provides an SSR no-op without resolving SwPush or reading browser globals', async () => {
    const { options } = setup();
    const resolveSw = vi.fn(() => {
      throw new Error('must not resolve browser service');
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: SwPush, useFactory: resolveSw },
        provideShipPush(() => options),
      ],
    });
    const client = TestBed.runInInjectionContext(injectPush);
    expect(client.enabled).toBe(false);
    expect(client.ready()).toBe(true);
    await expect(client.subscribe()).rejects.toMatchObject({ code: 'unavailable' });
    expect(options.saveSubscription).not.toHaveBeenCalled();
    expect(resolveSw).not.toHaveBeenCalled();
  });

  it('works without a registered worker and closes browser observers with its injector', async () => {
    const { sw, options, messages } = setup();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideShipPush(options)],
    });
    expect(TestBed.inject(SHIP_PUSH).enabled).toBe(false);
    const child = createEnvironmentInjector(
      [{ provide: SwPush, useValue: sw }, provideShipPush(options)],
      TestBed.inject(EnvironmentInjector)
    );
    const client = child.get(SHIP_PUSH);
    expect(client.enabled).toBe(true);
    child.destroy();
    await expect(client.sync()).rejects.toMatchObject({ code: 'closed' });
    // The setup client still owns one observer; the injector-owned observer is removed.
    expect(messages.observers).toHaveLength(1);
  });
});
