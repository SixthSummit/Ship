import { utf8Bytes } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { WEBHOOK_VERIFIER_SUBPATHS } from "./index.js";
import { sharedSecretHeader, sharedSecretWebhookVerifier } from "./shared-secret.js";

const secret = "dedicated-rotatable-secret";
const body = utf8Bytes("{}");

function request(headers: Record<string, string>, key = secret) {
  return {
    headers,
    rawBody: body,
    method: "POST",
    canonicalUrl: "https://api.example.test/webhooks/partner",
    secret: key,
    now: new Date(),
  };
}

describe("sharedSecretWebhookVerifier", () => {
  it("declares no signature, freshness or replay guarantees and hides its header from storage", () => {
    const verifier = sharedSecretWebhookVerifier();
    expect(verifier.id).toBe("shared-secret");
    expect(verifier.guarantees).toEqual({ signature: false, freshness: false, replay: false });
    expect(verifier.sensitiveHeaders).toEqual(["x-webhook-secret"]);
    expect(sharedSecretWebhookVerifier({ header: "X-Partner-Token" }).sensitiveHeaders).toEqual([
      "x-partner-token",
    ]);
  });

  it("compares the raw header in constant time", async () => {
    const verifier = sharedSecretWebhookVerifier();
    expect(verifier.verify(request(sharedSecretHeader(secret)))).toEqual({ ok: true });
    expect(verifier.verify(request(sharedSecretHeader("wrong")))).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    expect(verifier.verify(request(sharedSecretHeader(`${secret}x`)))).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    expect(verifier.verify(request({}))).toEqual({
      ok: false,
      reason: "missing-signature",
    });
    expect(verifier.verify(request(sharedSecretHeader(secret), "rotated"))).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("supports the bearer scheme on a custom header", async () => {
    const verifier = sharedSecretWebhookVerifier({ header: "authorization", scheme: "bearer" });
    const headers = sharedSecretHeader(secret, { header: "authorization", scheme: "bearer" });
    expect(headers).toEqual({ authorization: `Bearer ${secret}` });
    expect(verifier.verify(request(headers))).toEqual({ ok: true });
    expect(verifier.verify(request({ authorization: secret }))).toEqual({
      ok: false,
      reason: "malformed-signature",
    });
    expect(verifier.verify(request({ authorization: "Bearer " }))).toEqual({
      ok: false,
      reason: "malformed-signature",
    });
  });

  it("lists the provider subpaths from the root entry without importing them", () => {
    expect([...WEBHOOK_VERIFIER_SUBPATHS]).toEqual([
      "stripe",
      "github",
      "slack",
      "twilio",
      "resend",
      "ghl",
      "shared-secret",
    ]);
  });
});
