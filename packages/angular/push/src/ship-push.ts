import { computed, signal } from '@angular/core';
import type { SwPush } from '@angular/service-worker';
import { Subscription } from 'rxjs';
import type {
  PushNotificationClick,
  ShipPushOptions,
  ShipPushSubscription,
} from './push-subscription';
import { ShipPushError } from './ship-push-error';

/** Signal-first client. It never requests permission until subscribe() is called by the app. */
export class ShipPush {
  private readonly current = signal<ShipPushSubscription | null>(null);
  private readonly working = signal(false);
  private readonly failure = signal<ShipPushError | undefined>(undefined);
  private readonly message = signal<object | undefined>(undefined);
  private readonly click = signal<PushNotificationClick | undefined>(undefined);
  private readonly listeners = new Subscription();
  private readonly controller = new AbortController();
  private closed = false;
  private readonly initialized = signal(false);
  private readonly sw: SwPush | null;
  private readonly options: ShipPushOptions;

  readonly enabled: boolean;
  readonly ready = this.initialized.asReadonly();
  readonly subscription = this.current.asReadonly();
  readonly subscribed = computed(() => this.current() !== null);
  readonly busy = this.working.asReadonly();
  readonly error = this.failure.asReadonly();
  readonly latestMessage = this.message.asReadonly();
  readonly latestClick = this.click.asReadonly();

  constructor(sw: SwPush | null, options: ShipPushOptions) {
    this.sw = sw;
    this.options = options;
    this.enabled = sw?.isEnabled === true;
    if (!this.enabled || !sw) {
      this.initialized.set(true);
      return;
    }
    this.listeners.add(
      sw.subscription.subscribe({
        next: subscription => {
          this.initialized.set(true);
          if (!subscription) {
            this.current.set(null);
            return;
          }
          try {
            this.current.set(this.serialize(subscription));
          } catch {
            this.initialized.set(false);
            this.current.set(null);
            this.failure.set(new ShipPushError('subscription-failed'));
          }
        },
        error: () => {
          this.initialized.set(false);
          this.failure.set(new ShipPushError('subscription-failed'));
        },
      })
    );
    this.listeners.add(sw.messages.subscribe(message => this.message.set(message)));
    this.listeners.add(sw.notificationClicks.subscribe(click => this.click.set(click)));
    this.listeners.add(
      sw.pushSubscriptionChanges?.subscribe(change => {
        if (!change.newSubscription) {
          this.current.set(null);
          this.initialized.set(true);
          return;
        }
        try {
          this.current.set(this.serialize(change.newSubscription));
          this.initialized.set(true);
        } catch {
          this.initialized.set(false);
          this.current.set(null);
          this.failure.set(new ShipPushError('subscription-failed'));
        }
      })
    );
  }

  /** Call directly from a user gesture. A failed save leaves the browser subscription available for sync(). */
  async subscribe(): Promise<ShipPushSubscription> {
    return this.run(async () => {
      let subscription: PushSubscription;
      try {
        subscription = await this.sw!.requestSubscription({
          serverPublicKey: this.options.serverPublicKey,
        });
      } catch (error: unknown) {
        throw new ShipPushError(
          typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            error.name === 'NotAllowedError'
            ? 'permission-denied'
            : 'subscription-failed'
        );
      }
      this.assertOpen();
      const value = this.serialize(subscription);
      this.current.set(value);
      this.initialized.set(true);
      await this.persist(() => this.options.saveSubscription(value, this.controller.signal));
      return value;
    });
  }

  /** Explicitly reconcile an existing/rotated subscription after the app resolves its authenticated identity. */
  async sync(): Promise<void> {
    return this.run(async () => {
      if (!this.initialized()) throw new ShipPushError('not-ready');
      const value = this.current();
      if (value)
        await this.persist(() => this.options.saveSubscription(value, this.controller.signal));
    });
  }

  /** Remove server ownership before revoking locally. On failure, retry while still authenticated. */
  async unsubscribe(): Promise<void> {
    return this.run(async () => {
      if (!this.initialized()) throw new ShipPushError('not-ready');
      const value = this.current();
      if (!value) return;
      await this.persist(() => this.options.removeSubscription(value, this.controller.signal));
      this.assertOpen();
      if (this.current()?.endpoint !== value.endpoint)
        throw new ShipPushError('subscription-changed');
      try {
        await this.sw!.unsubscribe();
      } catch {
        throw new ShipPushError('subscription-failed');
      }
      this.current.set(null);
    });
  }

  /** Stops observers and aborts persistence; the durable browser subscription survives. */
  destroy(): void {
    this.closed = true;
    this.controller.abort();
    this.listeners.unsubscribe();
    this.message.set(undefined);
    this.click.set(undefined);
  }

  private assertOpen(): void {
    if (this.closed) throw new ShipPushError('closed');
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (!this.enabled) throw new ShipPushError('unavailable');
    if (this.working()) throw new ShipPushError('busy');
    this.working.set(true);
    this.failure.set(undefined);
    try {
      return await action();
    } catch (error: unknown) {
      const failure =
        error instanceof ShipPushError ? error : new ShipPushError('subscription-failed');
      this.failure.set(failure);
      throw failure;
    } finally {
      this.working.set(false);
    }
  }

  private async persist(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.assertOpen();
    } catch {
      this.assertOpen();
      throw new ShipPushError('persistence-failed');
    }
  }

  private serialize(subscription: PushSubscription): ShipPushSubscription {
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth'])
      throw new ShipPushError('subscription-failed');
    return {
      endpoint: json.endpoint,
      expirationTime: json.expirationTime ?? null,
      keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
    };
  }
}
