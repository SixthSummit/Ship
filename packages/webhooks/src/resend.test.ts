import { bytesToBase64, utf8Bytes } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { resendSignatureHeaders, resendWebhookVerifier } from "./resend.js";

const secret = `whsec_${bytesToBase64(utf8Bytes("resend-signing-key-bytes"))}`;
const now = new Date("2026-09-18T12:00:00.000Z");
const body = utf8Bytes('{"type":"email.delivered","data":{"email_id":"e1"}}');
const verifier = resendWebhookVerifier();

function request(headers: Record<string, string>, rawBody = body, key = secret) {
  return {
    headers,
    rawBody,
    method: "POST",
    canonicalUrl: "https://api.example.test/webhooks/resend",
    secret: key,
    now,
  };
}

describe("resendWebhookVerifier", () => {
  it("verifies Svix headers, accepts multiple signatures and reports the signed id", async () => {
    expect(verifier.guarantees).toEqual({ signature: true, freshness: true, replay: false });
    expect(verifier.sensitiveHeaders).toEqual(["svix-signature", "webhook-signature"]);
    const headers = await resendSignatureHeaders({
      secret,
      rawBody: body,
      id: "msg_1",
      timestamp: now,
    });
    expect(headers["svix-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/u);
    await expect(verifier.verify(request({ ...headers }))).resolves.toEqual({
      ok: true,
      eventId: "msg_1",
      timestamp: now,
    });
    await expect(
      verifier.verify(
        request({ ...headers, "svix-signature": `v1,AAAA v1a,BBBB ${headers["svix-signature"]}` }),
      ),
    ).resolves.toMatchObject({ ok: true, eventId: "msg_1" });
    await expect(
      verifier.verify(
        request({
          "webhook-id": "msg_1",
          "webhook-timestamp": headers["svix-timestamp"] as string,
          "webhook-signature": headers["svix-signature"] as string,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, eventId: "msg_1" });
    // A bare (non-prefixed) secret is used as the raw key.
    const bare = await resendSignatureHeaders({
      secret: "plain",
      rawBody: body,
      id: "msg_2",
      timestamp: now,
    });
    await expect(verifier.verify(request({ ...bare }, body, "plain"))).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects bad signatures, tampered content, wrong secrets, stale and missing parts", async () => {
    const headers = await resendSignatureHeaders({
      secret,
      rawBody: body,
      id: "msg_1",
      timestamp: now,
    });
    await expect(
      verifier.verify(request({ ...headers, "svix-signature": "v1,AAAA" })),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(verifier.verify(request({ ...headers }, utf8Bytes("{}")))).resolves.toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    await expect(verifier.verify(request({ ...headers, "svix-id": "msg_9" }))).resolves.toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    await expect(
      verifier.verify(request({ ...headers }, body, `whsec_${bytesToBase64(utf8Bytes("other"))}`)),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    const stale = await resendSignatureHeaders({
      secret,
      rawBody: body,
      id: "msg_1",
      timestamp: new Date(now.getTime() - 10 * 60_000),
    });
    await expect(verifier.verify(request({ ...stale }))).resolves.toEqual({
      ok: false,
      reason: "timestamp-stale",
    });
    await expect(verifier.verify(request({}))).resolves.toEqual({
      ok: false,
      reason: "missing-signature",
    });
    await expect(
      verifier.verify(request({ "svix-signature": "v1,AAAA", "svix-id": "msg_1" })),
    ).resolves.toEqual({ ok: false, reason: "timestamp-missing" });
    await expect(verifier.verify(request({ ...headers, "svix-id": "" }))).resolves.toEqual({
      ok: false,
      reason: "malformed-signature",
    });
    await expect(
      verifier.verify(request({ ...headers, "svix-timestamp": "later" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    await expect(
      verifier.verify(request({ ...headers, "svix-signature": "v2,AAAA" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    await expect(
      verifier.verify(request({ ...headers, "svix-signature": "v1,***" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    await expect(verifier.verify(request({ ...headers }, body, "whsec_***"))).rejects.toThrow(
      /whsec_/u,
    );
  });
});
