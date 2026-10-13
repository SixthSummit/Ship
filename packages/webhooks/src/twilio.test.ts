import { utf8Bytes } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { TWILIO_SIGNATURE_HEADER, twilioSignatureHeader, twilioWebhookVerifier } from "./twilio.js";

const authToken = "twilio_auth_token_fixture";
const canonicalUrl = "https://api.example.test/webhooks/twilio";
const form = "To=%2B15551234567&From=%2B15557654321&Body=Hello+there&MessageSid=SM1";
const verifier = twilioWebhookVerifier();

function request(
  headers: Record<string, string>,
  options: Partial<{ rawBody: Uint8Array; url: string; secret: string }> = {},
) {
  return {
    headers,
    rawBody: options.rawBody ?? utf8Bytes(form),
    method: "POST",
    canonicalUrl: options.url ?? canonicalUrl,
    secret: options.secret ?? authToken,
    now: new Date(),
  };
}

describe("twilioWebhookVerifier", () => {
  it("verifies HMAC-SHA1 over the canonical URL plus sorted form parameters", async () => {
    expect(verifier.guarantees).toEqual({ signature: true, freshness: false, replay: false });
    expect(verifier.sensitiveHeaders).toEqual(["x-twilio-signature"]);
    const signature = await twilioSignatureHeader({ authToken, url: canonicalUrl, rawBody: form });
    expect(signature).toMatch(/^[A-Za-z0-9+/]{27}=$/u);
    await expect(
      verifier.verify(
        request({
          [TWILIO_SIGNATURE_HEADER]: signature,
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        }),
      ),
    ).resolves.toEqual({ ok: true });
    // Parameter order on the wire does not matter; the canonical form sorts keys and values.
    const reordered = utf8Bytes(
      "MessageSid=SM1&Body=Hello+there&From=%2B15557654321&To=%2B15551234567",
    );
    await expect(
      verifier.verify(
        request(
          {
            [TWILIO_SIGNATURE_HEADER]: signature,
            "content-type": "application/x-www-form-urlencoded",
          },
          { rawBody: reordered },
        ),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("verifies JSON bodies through the bodySHA256 query convention", async () => {
    const json = '{"MessageSid":"SM2"}';
    const signature = await twilioSignatureHeader({
      authToken,
      url: canonicalUrl,
      rawBody: json,
      contentType: "application/json",
    });
    await expect(
      verifier.verify(
        request(
          { [TWILIO_SIGNATURE_HEADER]: signature, "content-type": "application/json" },
          { rawBody: utf8Bytes(json) },
        ),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifier.verify(
        request(
          { [TWILIO_SIGNATURE_HEADER]: signature, "content-type": "application/json" },
          { rawBody: utf8Bytes('{"MessageSid":"SM3"}') },
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    const withQuery = await twilioSignatureHeader({
      authToken,
      url: `${canonicalUrl}?tenant=acme`,
      rawBody: json,
      contentType: "application/json",
    });
    await expect(
      verifier.verify(
        request(
          { [TWILIO_SIGNATURE_HEADER]: withQuery, "content-type": "application/json" },
          { rawBody: utf8Bytes(json), url: `${canonicalUrl}?tenant=acme` },
        ),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("verifies against the declared canonical URL regardless of proxy-rewritten hosts", async () => {
    // Twilio signed the public URL it was configured with.
    const signature = await twilioSignatureHeader({ authToken, url: canonicalUrl, rawBody: form });
    const proxied = {
      [TWILIO_SIGNATURE_HEADER]: signature,
      "content-type": "application/x-www-form-urlencoded",
      host: "internal-service:8080",
      "x-forwarded-host": "edge.internal",
      "x-forwarded-proto": "http",
    };
    // The verifier only sees the framework-derived canonical URL, so the rewritten headers are inert.
    await expect(verifier.verify(request(proxied))).resolves.toEqual({ ok: true });
    // Had the URL been taken from the request, verification would fail.
    await expect(
      verifier.verify(request(proxied, { url: "http://internal-service:8080/webhooks/twilio" })),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects bad signatures, tampered parameters, wrong tokens and malformed headers", async () => {
    const signature = await twilioSignatureHeader({ authToken, url: canonicalUrl, rawBody: form });
    const formType = { "content-type": "application/x-www-form-urlencoded" };
    await expect(
      verifier.verify(
        request({ ...formType, [TWILIO_SIGNATURE_HEADER]: signature }, { secret: "x" }),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(
      verifier.verify(
        request(
          { ...formType, [TWILIO_SIGNATURE_HEADER]: signature },
          { rawBody: utf8Bytes(`${form}&Extra=1`) },
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(verifier.verify(request(formType))).resolves.toEqual({
      ok: false,
      reason: "missing-signature",
    });
    await expect(
      verifier.verify(request({ ...formType, [TWILIO_SIGNATURE_HEADER]: "not base64!" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    await expect(
      verifier.verify(request({ ...formType, [TWILIO_SIGNATURE_HEADER]: "AAAA" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    await expect(
      verifier.verify(
        request(
          { ...formType, [TWILIO_SIGNATURE_HEADER]: signature },
          { rawBody: new Uint8Array([0xff, 0xfe]) },
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: "unsupported-request" });
  });
});
