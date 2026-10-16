/** Serialized browser subscription. Treat its endpoint and keys as credentials. */
export interface WebPushSubscription {
  readonly endpoint: string;
  readonly expirationTime?: number | null;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export type PushJson =
  | null
  | boolean
  | number
  | string
  | readonly PushJson[]
  | { readonly [key: string]: PushJson };

/** Angular service worker payload; data is delivered unchanged on notification clicks. */
export interface PushNotification {
  readonly title: string;
  readonly body?: string;
  readonly icon?: string;
  readonly badge?: string;
  readonly tag?: string;
  readonly data?: { readonly [key: string]: PushJson };
}

export interface PushSendOptions {
  /** Retention at the push service, in seconds. Default: 3600; maximum: 28 days. */
  readonly ttlSeconds?: number;
  readonly urgency?: "very-low" | "low" | "normal" | "high";
  /** At most 32 base64url characters; coalesces messages at the push service. */
  readonly topic?: string;
}

/** Accepted means the push service accepted the message, not that the device displayed it. */
export type PushDeliveryResult =
  | { readonly status: "accepted"; readonly statusCode: number }
  | { readonly status: "expired"; readonly statusCode: 404 | 410 }
  | {
      readonly status: "retryable";
      readonly statusCode?: number;
      readonly retryAfterSeconds?: number;
    }
  | { readonly status: "rejected"; readonly statusCode: number };

export interface WebPushSender {
  send(
    subscription: WebPushSubscription,
    notification: PushNotification,
    options?: PushSendOptions,
  ): Promise<PushDeliveryResult>;
}

export interface WebPushSenderOptions {
  readonly vapid: {
    readonly subject: string;
    readonly publicKey: string;
    readonly privateKey: string;
  };
  /** Exact HTTPS origins, chosen by the operator, never from subscription input. No wildcards. */
  readonly allowedPushOrigins: readonly string[];
  /** Socket timeout in milliseconds, default 10000. */
  readonly timeoutMs?: number;
}
