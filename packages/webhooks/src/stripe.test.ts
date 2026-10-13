import { utf8Bytes } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { STRIPE_SIGNATURE_HEADER, stripeSignatureHeader, stripeWebhookVerifier } from "./stripe.js";

const secret = "whsec_stripe_fixture";
const now = new Date("2026-09-18T12:00:00.000Z");
const body = utf8Bytes('{"id":"evt_1Abc","object":"event","type":"invoice.paid"}');
const verifier = stripeWebhookVerifier();

function request(headers: Record<string, string>, rawBody = body, key = secret) {
  return {
    headers,
    rawBody,
    method: "POST",
    canonicalUrl: "https://api.example.test/webhooks/stripe",
    secret: key,
    now,
  };
}

describe("stripeWebhookVerifier", () => {
  it("declares HMAC with authenticated freshness", () => {
    expect(verifier.id).toBe("stripe");
    expect(verifier.guarantees).toEqual({ signature: true, freshness: true, replay: false });
    expect(verifier.sensitiveHeaders).toEqual(["stripe-signature"]);
    expect(stripeWebhookVerifier({ id: "stripe.connect" }).id).toBe("stripe.connect");
  });

  it("verifies a recorded sample and reports the signed event id and timestamp", async () => {
    const header = await stripeSignatureHeader({ secret, rawBody: body, timestamp: now });
    expect(header).toMatch(/^t=1789732800,v1=[0-9a-f]{64}$/u);
    await expect(verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: header }))).resolves.toEqual({
      ok: true,
      eventId: "evt_1Abc",
      timestamp: now,
    });
    // Stripe may send several v1 entries during secret rotation; any match suffices.
    await expect(
      verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: `${header},v1=${"0".repeat(64)}` })),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: header }, utf8Bytes("not json"))),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("omits the event id when the signed body carries none", async () => {
    const plain = utf8Bytes('{"object":"event"}');
    const header = await stripeSignatureHeader({ secret, rawBody: plain, timestamp: now });
    await expect(
      verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: header }, plain)),
    ).resolves.toEqual({ ok: true, timestamp: now });
  });

  it("rejects bad signatures, tampered content, wrong secrets and stale timestamps", async () => {
    const header = await stripeSignatureHeader({ secret, rawBody: body, timestamp: now });
    await expect(
      verifier.verify(
        request({ [STRIPE_SIGNATURE_HEADER]: header.replace(/v1=.{4}/u, "v1=0000") }),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(
      verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: header }, utf8Bytes('{"id":"evt_2"}'))),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(
      verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: header }, body, "other")),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    const stale = await stripeSignatureHeader({
      secret,
      rawBody: body,
      timestamp: new Date(now.getTime() - 6 * 60_000),
    });
    await expect(verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: stale }))).resolves.toEqual({
      ok: false,
      reason: "timestamp-stale",
    });
    await expect(
      stripeWebhookVerifier({ toleranceMs: 10 * 60_000 }).verify(
        request({ [STRIPE_SIGNATURE_HEADER]: stale }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects missing or malformed headers", async () => {
    await expect(verifier.verify(request({}))).resolves.toEqual({
      ok: false,
      reason: "missing-signature",
    });
    for (const malformed of ["t=1", "v1=ab", "t=abc,v1=ab", "t=1,v1=zz", ",,,", "t=1,v1="]) {
      await expect(
        verifier.verify(request({ [STRIPE_SIGNATURE_HEADER]: malformed })),
      ).resolves.toEqual({
        ok: false,
        reason: "malformed-signature",
      });
    }
  });
});
