import { utf8Bytes } from "@sixthsummit/ship-core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  exportPublicKeyPem,
  GHL_ED25519_SIGNATURE_HEADER,
  GHL_RSA_SIGNATURE_HEADER,
  ghlSignatureHeader,
  ghlWebhookVerifier,
} from "./ghl.js";

const body = utf8Bytes('{"type":"ContactCreate","locationId":"loc_1"}');

function request(headers: Record<string, string>, secret: string, rawBody = body) {
  return {
    headers,
    rawBody,
    method: "POST",
    canonicalUrl: "https://api.example.test/webhooks/ghl",
    secret,
    now: new Date(),
  };
}

describe("ghlWebhookVerifier", () => {
  let ed25519: CryptoKeyPair;
  let rsa: CryptoKeyPair;
  let ed25519Pem: string;
  let rsaPem: string;

  beforeAll(async () => {
    ed25519 = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    rsa = (await globalThis.crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    ed25519Pem = await exportPublicKeyPem(ed25519.publicKey);
    rsaPem = await exportPublicKeyPem(rsa.publicKey);
  });

  it("verifies the current Ed25519 scheme with a PEM public key as the rotatable secret", async () => {
    const verifier = ghlWebhookVerifier();
    expect(verifier.id).toBe("ghl");
    expect(verifier.guarantees).toEqual({ signature: true, freshness: false, replay: false });
    expect(verifier.sensitiveHeaders).toEqual(["x-ghl-signature"]);
    expect(ed25519Pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----$/u);
    const signature = await ghlSignatureHeader({ privateKey: ed25519.privateKey, rawBody: body });
    await expect(
      verifier.verify(request({ [GHL_ED25519_SIGNATURE_HEADER]: signature }, ed25519Pem)),
    ).resolves.toEqual({ ok: true });
    // The imported key is cached per PEM; a second verification still succeeds.
    await expect(
      verifier.verify(request({ [GHL_ED25519_SIGNATURE_HEADER]: signature }, ed25519Pem)),
    ).resolves.toEqual({ ok: true });
  });

  it("verifies the legacy RSA-SHA256 scheme when configured", async () => {
    const verifier = ghlWebhookVerifier({ algorithm: "rsa-sha256", id: "ghl.legacy" });
    expect(verifier.id).toBe("ghl.legacy");
    const signature = await ghlSignatureHeader({
      privateKey: rsa.privateKey,
      rawBody: '{"type":"ContactCreate","locationId":"loc_1"}',
      algorithm: "rsa-sha256",
    });
    await expect(
      verifier.verify(request({ [GHL_RSA_SIGNATURE_HEADER]: signature }, rsaPem)),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifier.verify(request({ [GHL_RSA_SIGNATURE_HEADER]: signature }, rsaPem, utf8Bytes("{}"))),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects bad signatures, tampered content, the wrong key, and malformed input", async () => {
    const verifier = ghlWebhookVerifier();
    const signature = await ghlSignatureHeader({ privateKey: ed25519.privateKey, rawBody: body });
    await expect(
      verifier.verify(
        request({ [GHL_ED25519_SIGNATURE_HEADER]: signature }, ed25519Pem, utf8Bytes("{}")),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    const other = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await expect(
      verifier.verify(
        request(
          { [GHL_ED25519_SIGNATURE_HEADER]: signature },
          await exportPublicKeyPem(other.publicKey),
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(verifier.verify(request({}, ed25519Pem))).resolves.toEqual({
      ok: false,
      reason: "missing-signature",
    });
    for (const malformed of ["", "not base64!", "AAA"]) {
      await expect(
        verifier.verify(request({ [GHL_ED25519_SIGNATURE_HEADER]: malformed }, ed25519Pem)),
      ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    }
    await expect(
      verifier.verify(request({ [GHL_ED25519_SIGNATURE_HEADER]: signature }, "not a pem")),
    ).rejects.toThrow(/PEM/u);
    // A key of the wrong type is a configuration error, not a verification outcome.
    await expect(
      verifier.verify(request({ [GHL_ED25519_SIGNATURE_HEADER]: signature }, rsaPem)),
    ).rejects.toThrow();
  });
});
