import type { WebhookVerifier } from "@sixthsummit/ship-core";
import { base64ToBytes, bytesToBase64, defineWebhookVerifier } from "@sixthsummit/ship-core";

/**
 * HighLevel (GoHighLevel) signs marketplace webhooks with a public-key
 * signature over the exact raw body:
 *
 * - `X-GHL-Signature`: base64 Ed25519 signature (current scheme);
 * - `X-WH-Signature`: base64 RSA-SHA256 (PKCS#1 v1.5) signature (legacy
 *   scheme, announced for retirement in 2026).
 *
 * The "secret" handed to the verifier is therefore HighLevel's published
 * public key in PEM (SPKI) form, not a shared secret; rotate it like any
 * other secret through the webhook secret source. Neither scheme carries a
 * timestamp, so freshness is not guaranteed and the idempotency window is the
 * replay defence; the default key is the signed body digest. The verifier
 * does not embed HighLevel's keys: copy the current key from the HighLevel
 * marketplace webhook documentation into configuration.
 */
export interface GhlWebhookVerifierOptions {
  /** Which HighLevel scheme this verifier accepts; defaults to `ed25519`. */
  readonly algorithm?: "ed25519" | "rsa-sha256";
  readonly id?: string;
}

export const GHL_ED25519_SIGNATURE_HEADER = "x-ghl-signature";
export const GHL_RSA_SIGNATURE_HEADER = "x-wh-signature";
const PEM_PATTERN = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----/u;

/** WebCrypto types derived from the runtime so no DOM lib is required. */
type CryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
type AlgorithmIdentifier = Parameters<typeof globalThis.crypto.subtle.verify>[0];

export function ghlWebhookVerifier(options: GhlWebhookVerifierOptions = {}): WebhookVerifier {
  const algorithm = options.algorithm ?? "ed25519";
  const header = algorithm === "ed25519" ? GHL_ED25519_SIGNATURE_HEADER : GHL_RSA_SIGNATURE_HEADER;
  const keys = new Map<string, Promise<CryptoKey>>();
  const importKey = (pem: string): Promise<CryptoKey> => {
    const cached = keys.get(pem);
    if (cached) return cached;
    const imported = importPublicKey(pem, algorithm);
    keys.set(pem, imported);
    imported.catch(() => keys.delete(pem));
    return imported;
  };
  return defineWebhookVerifier({
    id: options.id ?? "ghl",
    guarantees: { signature: true, freshness: false, replay: false },
    sensitiveHeaders: [header],
    verify: async ({ headers, rawBody, secret }) => {
      const presented = headers[header];
      if (presented === undefined) return { ok: false, reason: "missing-signature" };
      const signature = base64ToBytes(presented);
      if (!signature || signature.byteLength === 0) {
        return { ok: false, reason: "malformed-signature" };
      }
      const key = await importKey(secret);
      const valid = await globalThis.crypto.subtle.verify(
        verifyAlgorithm(algorithm),
        key,
        toBuffer(signature),
        toBuffer(rawBody),
      );
      return valid ? { ok: true } : { ok: false, reason: "signature-mismatch" };
    },
  });
}

/** Test helper: signs `rawBody` with a private key generated for the same scheme. */
export async function ghlSignatureHeader(input: {
  readonly privateKey: CryptoKey;
  readonly rawBody: Uint8Array | string;
  readonly algorithm?: "ed25519" | "rsa-sha256";
}): Promise<string> {
  const body =
    typeof input.rawBody === "string" ? new TextEncoder().encode(input.rawBody) : input.rawBody;
  const signature = await globalThis.crypto.subtle.sign(
    verifyAlgorithm(input.algorithm ?? "ed25519"),
    input.privateKey,
    toBuffer(body),
  );
  return bytesToBase64(new Uint8Array(signature));
}

/** Test helper: exports a WebCrypto public key as the PEM the verifier consumes. */
export async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", publicKey));
  const lines = bytesToBase64(spki).match(/.{1,64}/gu) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function importPublicKey(
  pem: string,
  algorithm: "ed25519" | "rsa-sha256",
): Promise<CryptoKey> {
  const match = PEM_PATTERN.exec(pem);
  const der = match ? base64ToBytes(match[1]?.replace(/\s+/gu, "") ?? "") : undefined;
  if (!der) {
    throw new TypeError(
      "HighLevel webhook public key must be a PEM-encoded SPKI public key; check the configured key",
    );
  }
  return globalThis.crypto.subtle.importKey(
    "spki",
    toBuffer(der),
    algorithm === "ed25519" ? { name: "Ed25519" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function verifyAlgorithm(algorithm: "ed25519" | "rsa-sha256"): AlgorithmIdentifier {
  return algorithm === "ed25519" ? { name: "Ed25519" } : { name: "RSASSA-PKCS1-v1_5" };
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
