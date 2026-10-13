import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "./envelope.js";
import {
  CLIENT_EVENTS,
  handshakeErrorFor,
  parsePresenceOnlineMessage,
  parsePresenceSnapshotMessage,
  parseSubscribeMessage,
  parseUnsubscribeMessage,
  presenceErrorFor,
  SERVER_EVENTS,
  SHIP_NAMESPACE,
  subscribeErrorFor,
} from "./protocol.js";
import { createTokenBucket } from "./rate-limit.js";

describe("wire protocol constants", () => {
  it("matches the canonical v1 names", () => {
    expect(SHIP_NAMESPACE).toBe("/ship");
    expect(CLIENT_EVENTS).toEqual({
      subscribe: "ship:subscribe",
      unsubscribe: "ship:unsubscribe",
      presenceSnapshot: "ship:presence.snapshot",
      presenceOnline: "ship:presence.online",
    });
    expect(SERVER_EVENTS).toEqual({
      event: "ship:event",
      presence: "ship:presence",
      dropped: "ship:dropped",
    });
  });
});

describe("message parsing", () => {
  it("accepts well-formed subscribe messages and classifies malformed ones", () => {
    expect(parseSubscribeMessage({ channel: "a.b", scopeKey: "x-1" })).toEqual({
      ok: true,
      message: { channel: "a.b", scopeKey: "x-1" },
    });
    expect(parseSubscribeMessage(null)).toEqual({ ok: false, code: "CHANNEL_NOT_FOUND" });
    expect(parseSubscribeMessage({ channel: "Bad", scopeKey: "x" })).toEqual({
      ok: false,
      code: "CHANNEL_NOT_FOUND",
    });
    expect(parseSubscribeMessage({ channel: "a.b", scopeKey: "has space" })).toEqual({
      ok: false,
      code: "INVALID_SCOPE",
    });
    expect(parseSubscribeMessage({ channel: "a.b" })).toEqual({ ok: false, code: "INVALID_SCOPE" });
  });

  it("parses presence snapshot paging and online queries", () => {
    expect(parsePresenceSnapshotMessage({ channel: "a.b", scopeKey: "x" })).toEqual({
      ok: true,
      message: { channel: "a.b", scopeKey: "x" },
    });
    expect(
      parsePresenceSnapshotMessage({ channel: "a.b", scopeKey: "x", cursor: "m", limit: 5 }),
    ).toEqual({ ok: true, message: { channel: "a.b", scopeKey: "x", cursor: "m", limit: 5 } });
    expect(
      parsePresenceSnapshotMessage({ channel: "a.b", scopeKey: "x", limit: 1_000_000 }),
    ).toEqual({ ok: true, message: { channel: "a.b", scopeKey: "x", limit: 1_000 } });
    expect(parsePresenceSnapshotMessage({ channel: "a.b", scopeKey: "x", limit: 0 })).toEqual({
      ok: false,
      code: "INVALID_PAGE",
    });
    expect(parsePresenceSnapshotMessage({ channel: "a.b", scopeKey: "x", cursor: "" })).toEqual({
      ok: false,
      code: "INVALID_PAGE",
    });
    expect(parsePresenceSnapshotMessage({ channel: "a.b", scopeKey: "x", cursor: 1 })).toEqual({
      ok: false,
      code: "INVALID_PAGE",
    });
    expect(parsePresenceSnapshotMessage({ channel: "Bad", scopeKey: "x" })).toEqual({
      ok: false,
      code: "CHANNEL_NOT_FOUND",
    });
    expect(parsePresenceOnlineMessage({ channel: "a.b", scopeKey: "x", actorId: "u1" })).toEqual({
      ok: true,
      message: { channel: "a.b", scopeKey: "x", actorId: "u1" },
    });
    expect(parsePresenceOnlineMessage({ channel: "a.b", scopeKey: "x" })).toEqual({
      ok: false,
      code: "INVALID_SCOPE",
    });
    expect(
      parsePresenceOnlineMessage({ channel: "a.b", scopeKey: "x", actorId: "u".repeat(300) }),
    ).toEqual({ ok: false, code: "INVALID_SCOPE" });
    expect(
      parsePresenceOnlineMessage({ channel: "a.b", scopeKey: "bad key", actorId: "u" }),
    ).toEqual({ ok: false, code: "INVALID_SCOPE" });
    expect(presenceErrorFor("page-invalid")).toEqual({
      code: "INVALID_PAGE",
      message: "Presence cursor or limit is not valid",
    });
  });

  it("parses unsubscribe messages", () => {
    expect(parseUnsubscribeMessage({ subscriptionId: "gw:1" })).toEqual({ subscriptionId: "gw:1" });
    expect(parseUnsubscribeMessage({ subscriptionId: "" })).toBeUndefined();
    expect(parseUnsubscribeMessage("gw:1")).toBeUndefined();
  });

  it("maps kernel reasons onto wire codes and fails closed on unavailability", () => {
    expect(subscribeErrorFor("channel-not-found").code).toBe("CHANNEL_NOT_FOUND");
    expect(subscribeErrorFor("scope-invalid").code).toBe("INVALID_SCOPE");
    expect(subscribeErrorFor("forbidden").code).toBe("SUBSCRIPTION_FORBIDDEN");
    expect(subscribeErrorFor("unavailable").code).toBe("SUBSCRIPTION_FORBIDDEN");
    expect(presenceErrorFor("channel-not-found").code).toBe("CHANNEL_NOT_FOUND");
    expect(presenceErrorFor("presence-disabled").code).toBe("PRESENCE_DISABLED");
    expect(presenceErrorFor("scope-invalid").code).toBe("SUBSCRIPTION_FORBIDDEN");
    expect(presenceErrorFor("forbidden").code).toBe("SUBSCRIPTION_FORBIDDEN");
    expect(presenceErrorFor("unavailable").code).toBe("SUBSCRIPTION_FORBIDDEN");
    expect(handshakeErrorFor("invalid-credential").code).toBe("AUTHENTICATION_ERROR");
    expect(handshakeErrorFor("forbidden").code).toBe("AUTHORIZATION_ERROR");
    expect(handshakeErrorFor("unavailable").code).toBe("AUTHENTICATION_UNAVAILABLE");
  });
});

describe("envelope codec", () => {
  it("round-trips message and presence envelopes and rejects garbage", () => {
    const message = {
      v: 1 as const,
      kind: "message" as const,
      channel: "a.b",
      scopeKey: "x",
      payload: { n: 1 },
      publishedAt: "2026-09-18T00:00:00.000Z",
      origin: "api",
    };
    const presence = {
      v: 1 as const,
      kind: "presence" as const,
      channel: "a.b",
      scopeKey: "x",
      event: "joined" as const,
      actorId: "alice",
      count: 1,
      publishedAt: "2026-09-18T00:00:00.000Z",
      origin: "gw",
    };
    expect(decodeEnvelope(encodeEnvelope(message))).toEqual(message);
    expect(decodeEnvelope(encodeEnvelope(presence))).toEqual(presence);
    expect(decodeEnvelope("not json")).toBeUndefined();
    expect(decodeEnvelope("null")).toBeUndefined();
    expect(decodeEnvelope(JSON.stringify({ ...message, v: 2 }))).toBeUndefined();
    expect(decodeEnvelope(JSON.stringify({ ...message, kind: "other" }))).toBeUndefined();
    expect(decodeEnvelope(JSON.stringify({ ...presence, event: "gone" }))).toBeUndefined();
  });
});

describe("createTokenBucket", () => {
  it("consumes a burst and refills over time", () => {
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 10 });
    const start = 1_000;
    expect(bucket.take(start)).toBe(true);
    expect(bucket.take(start)).toBe(true);
    expect(bucket.take(start)).toBe(false);
    expect(bucket.take(start + 100)).toBe(true);
    expect(bucket.take(start + 100)).toBe(false);
    expect(bucket.take(start + 5_000)).toBe(true);
    expect(bucket.take(start + 5_000)).toBe(true);
    expect(bucket.take(start + 5_000)).toBe(false);
    expect(bucket.take()).toBe(true);
    expect(bucket.capacity).toBe(2);
  });

  it("rejects invalid configuration", () => {
    expect(() => createTokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(TypeError);
    expect(() => createTokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(TypeError);
  });
});
