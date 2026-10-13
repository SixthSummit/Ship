import { utf8Bytes } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { GITHUB_SIGNATURE_HEADER, githubSignatureHeader, githubWebhookVerifier } from "./github.js";

const secret = "gh_fixture_secret";
const body = utf8Bytes('{"action":"opened","number":1}');
const verifier = githubWebhookVerifier();

function request(headers: Record<string, string>, rawBody = body, key = secret) {
  return {
    headers,
    rawBody,
    method: "POST",
    canonicalUrl: "https://api.example.test/webhooks/github",
    secret: key,
    now: new Date(),
  };
}

describe("githubWebhookVerifier", () => {
  it("declares HMAC without freshness and reports no unsigned delivery id", async () => {
    expect(verifier.guarantees).toEqual({ signature: true, freshness: false, replay: false });
    expect(verifier.sensitiveHeaders).toEqual(["x-hub-signature-256"]);
    const header = await githubSignatureHeader({ secret, rawBody: body });
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/u);
    await expect(
      verifier.verify(
        request({ [GITHUB_SIGNATURE_HEADER]: header, "x-github-delivery": "guid-1" }),
      ),
    ).resolves.toEqual({ ok: true });
    // The RFC 4231 style vector: HMAC-SHA256("gh_fixture_secret", body) is stable.
    await expect(
      githubSignatureHeader({ secret, rawBody: '{"action":"opened","number":1}' }),
    ).resolves.toBe(header);
  });

  it("rejects bad signatures, tampered content, wrong secrets and malformed headers", async () => {
    const header = await githubSignatureHeader({ secret, rawBody: body });
    await expect(
      verifier.verify(request({ [GITHUB_SIGNATURE_HEADER]: `sha256=${"0".repeat(64)}` })),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(
      verifier.verify(
        request({ [GITHUB_SIGNATURE_HEADER]: header }, utf8Bytes('{"action":"closed"}')),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(
      verifier.verify(request({ [GITHUB_SIGNATURE_HEADER]: header }, body, "nope")),
    ).resolves.toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    await expect(verifier.verify(request({}))).resolves.toEqual({
      ok: false,
      reason: "missing-signature",
    });
    for (const malformed of ["sha1=abcd", "sha256=abc", "sha256=zz", header.slice(0, 20)]) {
      await expect(
        verifier.verify(request({ [GITHUB_SIGNATURE_HEADER]: malformed })),
      ).resolves.toEqual({
        ok: false,
        reason: "malformed-signature",
      });
    }
  });
});
