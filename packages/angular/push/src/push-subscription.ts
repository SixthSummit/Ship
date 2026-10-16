/** Browser credentials; send only to your application's authenticated subscription operation. */
export interface ShipPushSubscription {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface ShipPushOptions {
  /** Public VAPID key only. Private signing keys belong on the server. */
  readonly serverPublicKey: string;
  /** Idempotently upsert this device for the authenticated actor and tenant. */
  readonly saveSubscription: (
    subscription: ShipPushSubscription,
    signal: AbortSignal
  ) => Promise<void>;
  /** Idempotently remove this device for the authenticated actor and tenant. */
  readonly removeSubscription: (
    subscription: ShipPushSubscription,
    signal: AbortSignal
  ) => Promise<void>;
}

export interface PushNotificationClick {
  readonly action: string;
  readonly notification: NotificationOptions & { readonly title: string };
}
