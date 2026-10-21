import { createECDH, ECDH } from "node:crypto";
import type {
  PushNotification,
  PushSendOptions,
  WebPushSenderOptions,
  WebPushSubscription,
} from "./push-types.js";

export class PushValidationError extends TypeError {
  readonly code = "SHIP_PUSH_INVALID_INPUT";
  constructor() {
    super("Invalid Web Push configuration, subscription, notification, or delivery options");
    this.name = "PushValidationError";
  }
}

function invalid(): never {
  throw new PushValidationError();
}

function key(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) return invalid();
  return bytes;
}

function publicKey(value: unknown): void {
  const bytes = key(value, 65);
  try {
    ECDH.convertKey(bytes, "prime256v1");
  } catch {
    invalid();
  }
}

export function pushUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return invalid();
    return url;
  } catch {
    return invalid();
  }
}

export function validateSender(options: WebPushSenderOptions): ReadonlySet<string> {
  if (
    !options?.vapid ||
    !Array.isArray(options.allowedPushOrigins) ||
    !options.allowedPushOrigins.length
  )
    return invalid();
  try {
    const subject = new URL(options.vapid.subject);
    if (
      !["mailto:", "https:"].includes(subject.protocol) ||
      subject.username ||
      subject.password ||
      subject.hash
    )
      return invalid();
  } catch {
    return invalid();
  }
  publicKey(options.vapid.publicKey);
  const privateKey = key(options.vapid.privateKey, 32);
  try {
    const pair = createECDH("prime256v1");
    pair.setPrivateKey(privateKey);
    if (pair.getPublicKey().toString("base64url") !== options.vapid.publicKey) return invalid();
  } catch {
    return invalid();
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  )
    return invalid();
  return new Set(
    options.allowedPushOrigins.map((origin) => {
      const url = pushUrl(origin);
      if (url.origin !== origin) return invalid();
      return origin;
    }),
  );
}

/** Parse untrusted operation input before persisting it. Returns a fresh credential object. */
export function parsePushSubscription(
  value: unknown,
  allowedPushOrigins: readonly string[],
): WebPushSubscription {
  if (!value || typeof value !== "object") return invalid();
  const input = value as Partial<WebPushSubscription>;
  if (
    typeof input.endpoint !== "string" ||
    input.endpoint.length > 4096 ||
    !allowedPushOrigins.includes(pushUrl(input.endpoint).origin)
  )
    return invalid();
  if (!input.keys) return invalid();
  publicKey(input.keys.p256dh);
  key(input.keys.auth, 16);
  const expirationTime = input.expirationTime ?? null;
  if (typeof expirationTime !== "number" && expirationTime !== null) return invalid();
  if (expirationTime !== null && (!Number.isFinite(expirationTime) || expirationTime < 0))
    return invalid();
  return {
    endpoint: input.endpoint,
    expirationTime,
    keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
  };
}

export function notificationPayload(notification: PushNotification): string {
  if (!notification || typeof notification.title !== "string" || !notification.title.trim())
    return invalid();
  for (const field of ["body", "icon", "badge", "tag"] as const) {
    if (notification[field] !== undefined && typeof notification[field] !== "string")
      return invalid();
  }
  if (
    notification.data !== undefined &&
    (notification.data === null ||
      typeof notification.data !== "object" ||
      Array.isArray(notification.data))
  )
    return invalid();
  try {
    const payload = JSON.stringify({ notification }, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) return invalid();
      if (["bigint", "function", "symbol", "undefined"].includes(typeof value)) return invalid();
      return value;
    });
    // Leave room for encryption framing within the usual 4096-byte push service limit.
    if (Buffer.byteLength(payload, "utf8") > 3072) return invalid();
    return payload;
  } catch {
    return invalid();
  }
}

export function validateSendOptions(options: PushSendOptions): void {
  if (
    options.ttlSeconds !== undefined &&
    (!Number.isSafeInteger(options.ttlSeconds) ||
      options.ttlSeconds < 0 ||
      options.ttlSeconds > 2419200)
  )
    invalid();
  if (
    options.urgency !== undefined &&
    !["very-low", "low", "normal", "high"].includes(options.urgency)
  )
    invalid();
  if (options.topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) invalid();
}
