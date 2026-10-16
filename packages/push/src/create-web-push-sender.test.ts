import { createECDH, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import { createWebPushSender } from "./create-web-push-sender.js";
import type { PushNotification, PushSendOptions } from "./push-types.js";
import { PushValidationError, parsePushSubscription } from "./push-validation.js";

const vapid = { subject: "mailto:push@example.test", ...webPush.generateVAPIDKeys() };
const allowedPushOrigins = ["https://push.example.test"];
const browser = createECDH("prime256v1");
browser.generateKeys();
const subscription = {
  endpoint: `${allowedPushOrigins[0]}/secret-device`,
  expirationTime: null,
  keys: {
    p256dh: browser.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  },
};

afterEach(() => vi.restoreAllMocks());

describe("Web Push delivery", () => {
  it("uses real encryption and per-instance VAPID signing without leaking plaintext", async () => {
    const send = vi
      .spyOn(webPush, "sendNotification")
      .mockImplementation(async (target, payload, options) => {
        const request = webPush.generateRequestDetails(target, payload, options);
        expect(request.endpoint).toBe(subscription.endpoint);
        expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
        expect(request.headers.Authorization).toMatch(/^vapid t=/);
        expect(Buffer.isBuffer(request.body)).toBe(true);
        expect(request.body?.includes(Buffer.from("Private message"))).toBe(false);
        expect(options).toMatchObject({ TTL: 3600, timeout: 10000, vapidDetails: vapid });
        return { statusCode: 201, headers: {}, body: "" };
      });
    const sender = createWebPushSender({ vapid, allowedPushOrigins });
    await expect(
      sender.send(subscription, { title: "Private message", body: "Ready", data: { id: "1" } }),
    ).resolves.toEqual({ status: "accepted", statusCode: 201 });
    expect(send).toHaveBeenCalledOnce();
  });

  it("isolates credentials and config from mutations and other sender instances", async () => {
    const send = vi
      .spyOn(webPush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, headers: {}, body: "" });
    const config = {
      vapid: { ...vapid },
      allowedPushOrigins: [...allowedPushOrigins],
      timeoutMs: 900,
    };
    const sender = createWebPushSender(config);
    config.vapid.privateKey = "changed";
    config.allowedPushOrigins.push("https://evil.test");
    const second = { ...vapid, ...webPush.generateVAPIDKeys() };
    await createWebPushSender({ vapid: second, allowedPushOrigins }).send(subscription, {
      title: "Second",
    });
    await sender.send(
      subscription,
      { title: "First" },
      { ttlSeconds: 0, urgency: "high", topic: "collapse_1" },
    );
    expect(send.mock.calls[0]?.[2]?.vapidDetails).toEqual(second);
    expect(send.mock.calls[1]?.[2]).toMatchObject({
      vapidDetails: vapid,
      timeout: 900,
      TTL: 0,
      urgency: "high",
      topic: "collapse_1",
    });
    await expect(
      sender.send({ ...subscription, endpoint: "https://evil.test/x" }, { title: "Invalid" }),
    ).rejects.toBeInstanceOf(PushValidationError);
  });

  it.each([
    [404, "expired"],
    [410, "expired"],
    [429, "retryable"],
    [500, "retryable"],
    [503, "retryable"],
    [400, "rejected"],
    [401, "rejected"],
    [403, "rejected"],
    [413, "rejected"],
  ])("classifies %i without exposing credentials or provider response bodies", async (statusCode, status) => {
    vi.spyOn(webPush, "sendNotification").mockRejectedValue({
      statusCode,
      endpoint: subscription.endpoint,
      body: "private body",
      headers: { "retry-after": "30" },
    });
    const result = await createWebPushSender({ vapid, allowedPushOrigins }).send(subscription, {
      title: "Hello",
    });
    expect(result).toEqual({
      status,
      statusCode,
      ...(status === "retryable" ? { retryAfterSeconds: 30 } : {}),
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret-device");
  });

  it.each([
    new Error("credential"),
    null,
    { statusCode: "500" },
    { statusCode: 999 },
  ])("redacts network and malformed provider errors", async (error) => {
    vi.spyOn(webPush, "sendNotification").mockRejectedValue(error);
    await expect(
      createWebPushSender({ vapid, allowedPushOrigins }).send(subscription, { title: "Hello" }),
    ).resolves.toEqual({ status: "retryable" });
  });

  it.each([
    "later",
    "-1",
    "Infinity",
    undefined,
  ])("ignores invalid Retry-After values: %s", async (retryAfter) => {
    vi.spyOn(webPush, "sendNotification").mockRejectedValue({
      statusCode: 429,
      headers: { "retry-after": retryAfter },
    });
    await expect(
      createWebPushSender({ vapid, allowedPushOrigins }).send(subscription, { title: "Hello" }),
    ).resolves.toEqual({ status: "retryable", statusCode: 429 });
  });
});

describe("untrusted subscriptions and configuration", () => {
  it.each([
    "http://push.example.test/x",
    "https://127.0.0.1/x",
    "https://push.example.test.evil.test/x",
    "https://push.example.test:8443/x",
    "https://user:password@push.example.test/x",
    "https://push.example.test/x#fragment",
    "not a url",
  ])("rejects unsafe endpoints before network access: %s", async (endpoint) => {
    const send = vi.spyOn(webPush, "sendNotification");
    await expect(
      createWebPushSender({ vapid, allowedPushOrigins }).send(
        { ...subscription, endpoint },
        { title: "Hello" },
      ),
    ).rejects.toMatchObject({ code: "SHIP_PUSH_INVALID_INPUT" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { ...subscription, keys: undefined },
    { ...subscription, keys: { p256dh: "not-a-point", auth: "invalid" } },
    { ...subscription, keys: { ...subscription.keys, auth: "a" } },
    {
      ...subscription,
      keys: { ...subscription.keys, p256dh: Buffer.alloc(65).toString("base64url") },
    },
    { ...subscription, expirationTime: -1 },
    { ...subscription, expirationTime: "tomorrow" },
    { ...subscription, endpoint: `https://push.example.test/${"a".repeat(4096)}` },
  ])("rejects malformed subscription credentials", (value) => {
    expect(() => parsePushSubscription(value, allowedPushOrigins)).toThrow(PushValidationError);
  });

  it("copies validated input and normalizes an absent expiration", () => {
    const value = parsePushSubscription(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      allowedPushOrigins,
    );
    expect(value).toEqual(subscription);
    expect(value.keys).not.toBe(subscription.keys);
  });

  it.each([
    { allowedPushOrigins: [] },
    { allowedPushOrigins: ["https://push.example.test/"] },
    { allowedPushOrigins: ["*"] },
    { timeoutMs: 0 },
    { vapid: { ...vapid, subject: "invalid" } },
    { vapid: { ...vapid, subject: "ftp://example.test" } },
    { vapid: { ...vapid, publicKey: "invalid" } },
    { vapid: { ...vapid, privateKey: randomBytes(32).toString("base64url") } },
  ])("rejects invalid sender config", (override) => {
    expect(() => createWebPushSender({ vapid, allowedPushOrigins, ...override })).toThrow(
      PushValidationError,
    );
  });

  it.each([
    { title: "" },
    { title: "a", body: 42 },
    { title: "a", data: [] },
    { title: "a", data: null },
    { title: "a", data: { number: NaN } },
    { title: "a", body: "a".repeat(3072) },
    { title: "a", data: { callback: () => 1 } },
    { title: "a", data: { bad: undefined } },
  ])("rejects invalid or oversized notification payloads", async (value) => {
    const send = vi.spyOn(webPush, "sendNotification");
    await expect(
      createWebPushSender({ vapid, allowedPushOrigins }).send(
        subscription,
        value as PushNotification,
      ),
    ).rejects.toThrow(PushValidationError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { ttlSeconds: -1 },
    { ttlSeconds: 2419201 },
    { ttlSeconds: 1.5 },
    { urgency: "urgent" },
    { topic: "x".repeat(33) },
    { topic: "has spaces" },
  ])("rejects invalid delivery options", async (value) => {
    await expect(
      createWebPushSender({ vapid, allowedPushOrigins }).send(
        subscription,
        { title: "Hello" },
        value as PushSendOptions,
      ),
    ).rejects.toThrow(PushValidationError);
  });
});
