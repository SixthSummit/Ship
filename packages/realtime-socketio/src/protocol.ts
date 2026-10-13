/**
 * Ship realtime wire protocol v1 for the Socket.IO adapter.
 *
 * Everything Socket.IO-shaped lives here and in the gateway; the kernel and
 * the client manifest never see namespaces, event names, or acks. The
 * canonical text is docs/v4/realtime.md.
 */
import type {
  RealtimePresenceFailureReason,
  RealtimeSubscriptionFailureReason,
} from "@sixthsummit/ship-core";
import { REALTIME_PRESENCE_MAX_LIMIT, REALTIME_SCOPE_KEY_PATTERN } from "@sixthsummit/ship-core";

export const SHIP_NAMESPACE = "/ship";
export const WIRE_VERSION = 1;

export const CLIENT_EVENTS = Object.freeze({
  subscribe: "ship:subscribe",
  unsubscribe: "ship:unsubscribe",
  presenceSnapshot: "ship:presence.snapshot",
  presenceOnline: "ship:presence.online",
});

export const SERVER_EVENTS = Object.freeze({
  event: "ship:event",
  presence: "ship:presence",
  dropped: "ship:dropped",
});

/** Reason attached to a forced disconnect of a slow subscriber. */
export const SLOW_SUBSCRIBER_DISCONNECT_REASON = "ship:slow-subscriber";

export type HandshakeErrorCode =
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "AUTHENTICATION_UNAVAILABLE";

export type SubscribeErrorCode =
  | "CHANNEL_NOT_FOUND"
  | "SUBSCRIPTION_FORBIDDEN"
  | "INVALID_SCOPE"
  | "RATE_LIMITED";

export type UnsubscribeErrorCode = "UNKNOWN_SUBSCRIPTION";

export type PresenceErrorCode =
  | "SUBSCRIPTION_FORBIDDEN"
  | "CHANNEL_NOT_FOUND"
  | "PRESENCE_DISABLED"
  | "INVALID_PAGE";

export interface SubscribeMessage {
  readonly channel: string;
  readonly scopeKey: string;
}

export interface PresenceSnapshotMessage extends SubscribeMessage {
  /** Opaque cursor from a previous ack's `nextCursor`. */
  readonly cursor?: string;
  /** Members per page; clamped server-side to the kernel maximum. */
  readonly limit?: number;
}

export interface PresenceOnlineMessage extends SubscribeMessage {
  readonly actorId: string;
}

export interface UnsubscribeMessage {
  readonly subscriptionId: string;
}

export type SubscribeAck =
  | { readonly ok: true; readonly subscriptionId: string }
  | { readonly ok: false; readonly code: SubscribeErrorCode; readonly message: string };

export type UnsubscribeAck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: UnsubscribeErrorCode; readonly message: string };

export type PresenceSnapshotAck =
  | {
      readonly ok: true;
      /** Whole membership, not the page size. */
      readonly count: number;
      /** One page of sorted actor ids. */
      readonly members: readonly string[];
      /** Present when more members follow; send it back as `cursor`. */
      readonly nextCursor?: string;
    }
  | { readonly ok: false; readonly code: PresenceErrorCode; readonly message: string };

export type PresenceOnlineAck =
  | { readonly ok: true; readonly online: boolean }
  | { readonly ok: false; readonly code: PresenceErrorCode; readonly message: string };

export interface EventMessage {
  readonly channel: string;
  readonly scopeKey: string;
  readonly seq: number;
  readonly publishedAt: string;
  readonly payload: unknown;
}

export interface PresenceMessage {
  readonly channel: string;
  readonly scopeKey: string;
  readonly kind: "joined" | "left";
  readonly actorId: string;
  readonly count: number;
}

export interface DroppedMessage {
  readonly channel: string;
  readonly scopeKey: string;
  readonly dropped: number;
}

const CHANNEL_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
/** Cursors are actor ids; actor ids are bounded like scope keys so a cursor never grows unbounded. */
const PRESENCE_CURSOR_MAX_LENGTH = 256;
const ACTOR_ID_MAX_LENGTH = 256;

/** Parses a subscribe or presence request; malformed shapes map to the closest stable code. */
export function parseSubscribeMessage(
  value: unknown,
):
  | { readonly ok: true; readonly message: SubscribeMessage }
  | { readonly ok: false; readonly code: "CHANNEL_NOT_FOUND" | "INVALID_SCOPE" } {
  if (typeof value !== "object" || value === null) return { ok: false, code: "CHANNEL_NOT_FOUND" };
  const channel = Reflect.get(value, "channel");
  const scopeKey = Reflect.get(value, "scopeKey");
  if (typeof channel !== "string" || !CHANNEL_ID_PATTERN.test(channel)) {
    return { ok: false, code: "CHANNEL_NOT_FOUND" };
  }
  if (typeof scopeKey !== "string" || !REALTIME_SCOPE_KEY_PATTERN.test(scopeKey)) {
    return { ok: false, code: "INVALID_SCOPE" };
  }
  return { ok: true, message: Object.freeze({ channel, scopeKey }) };
}

/** Parses a snapshot request; paging fields are optional and validated, everything else as subscribe. */
export function parsePresenceSnapshotMessage(
  value: unknown,
):
  | { readonly ok: true; readonly message: PresenceSnapshotMessage }
  | { readonly ok: false; readonly code: "CHANNEL_NOT_FOUND" | "INVALID_SCOPE" | "INVALID_PAGE" } {
  const base = parseSubscribeMessage(value);
  if (!base.ok) return base;
  const cursor = Reflect.get(value as object, "cursor");
  const limit = Reflect.get(value as object, "limit");
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > PRESENCE_CURSOR_MAX_LENGTH)
  ) {
    return { ok: false, code: "INVALID_PAGE" };
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    return { ok: false, code: "INVALID_PAGE" };
  }
  return {
    ok: true,
    message: Object.freeze({
      ...base.message,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Math.min(limit, REALTIME_PRESENCE_MAX_LIMIT) } : {}),
    }),
  };
}

/** Parses an online query; a malformed actor id is reported as a forbidden lookup. */
export function parsePresenceOnlineMessage(
  value: unknown,
):
  | { readonly ok: true; readonly message: PresenceOnlineMessage }
  | { readonly ok: false; readonly code: "CHANNEL_NOT_FOUND" | "INVALID_SCOPE" } {
  const base = parseSubscribeMessage(value);
  if (!base.ok) return base;
  const actorId = Reflect.get(value as object, "actorId");
  if (typeof actorId !== "string" || actorId.length === 0 || actorId.length > ACTOR_ID_MAX_LENGTH) {
    return { ok: false, code: "INVALID_SCOPE" };
  }
  return { ok: true, message: Object.freeze({ ...base.message, actorId }) };
}

export function parseUnsubscribeMessage(value: unknown): UnsubscribeMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const subscriptionId = Reflect.get(value, "subscriptionId");
  return typeof subscriptionId === "string" && SUBSCRIPTION_ID_PATTERN.test(subscriptionId)
    ? Object.freeze({ subscriptionId })
    : undefined;
}

export function subscribeErrorFor(reason: RealtimeSubscriptionFailureReason): {
  readonly code: SubscribeErrorCode;
  readonly message: string;
} {
  switch (reason) {
    case "channel-not-found":
      return { code: "CHANNEL_NOT_FOUND", message: "Channel is not declared" };
    case "scope-invalid":
      return { code: "INVALID_SCOPE", message: "Scope key is not valid for this channel" };
    case "forbidden":
      return { code: "SUBSCRIPTION_FORBIDDEN", message: "Subscription denied" };
    default:
      // Authorization infrastructure failures fail closed on the wire.
      return { code: "SUBSCRIPTION_FORBIDDEN", message: "Subscription authorization unavailable" };
  }
}

export function presenceErrorFor(reason: RealtimePresenceFailureReason): {
  readonly code: PresenceErrorCode;
  readonly message: string;
} {
  switch (reason) {
    case "channel-not-found":
      return { code: "CHANNEL_NOT_FOUND", message: "Channel is not declared" };
    case "presence-disabled":
      return { code: "PRESENCE_DISABLED", message: "Channel does not track presence" };
    case "page-invalid":
      return { code: "INVALID_PAGE", message: "Presence cursor or limit is not valid" };
    case "scope-invalid":
      return { code: "SUBSCRIPTION_FORBIDDEN", message: "Scope key is not valid for this channel" };
    case "forbidden":
      return { code: "SUBSCRIPTION_FORBIDDEN", message: "Presence snapshot denied" };
    default:
      return { code: "SUBSCRIPTION_FORBIDDEN", message: "Presence authorization unavailable" };
  }
}

export function handshakeErrorFor(reason: "invalid-credential" | "forbidden" | "unavailable"): {
  readonly code: HandshakeErrorCode;
  readonly message: string;
} {
  switch (reason) {
    case "invalid-credential":
      return { code: "AUTHENTICATION_ERROR", message: "Authentication failed" };
    case "forbidden":
      return { code: "AUTHORIZATION_ERROR", message: "Access denied" };
    default:
      return { code: "AUTHENTICATION_UNAVAILABLE", message: "Authentication is unavailable" };
  }
}
