import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { InvalidCredentialAuthDefinitionError } from "../errors.js";

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const VERSION = "v1";

/**
 * Keys for encrypting MFA secrets at rest. `current` names the key new
 * ciphertexts use; every key in `keys` can still decrypt, so rotation is
 * "add a key, switch `current`, re-encrypt lazily, retire the old key". Each
 * key is 32 bytes (AES-256), given as raw bytes, hex or base64.
 */
export interface SecretKeyRing {
  readonly current: string;
  readonly keys: Readonly<Record<string, Uint8Array | string>>;
}

export interface SecretBox {
  readonly currentKeyId: string;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  /** The key id a ciphertext was sealed under, or `undefined` for a malformed value. */
  keyIdOf(ciphertext: string): string | undefined;
}

/**
 * AES-256-GCM with a random 96-bit nonce and the key id as associated data.
 * Output: `v1.<keyId>.<nonce>.<ciphertext>.<tag>` (base64url).
 */
export function createSecretBox(ring: SecretKeyRing): SecretBox {
  const keys = new Map<string, Buffer>();
  if (typeof ring !== "object" || ring === null || typeof ring.current !== "string") {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_KEY_INVALID",
      "MFA secret key ring must name a current key id and a keys map",
      { field: "secrets" },
    );
  }
  for (const [id, material] of Object.entries(ring.keys ?? {})) {
    if (!KEY_ID_PATTERN.test(id)) {
      throw new InvalidCredentialAuthDefinitionError(
        "SHIP_AUTH_KEY_INVALID",
        `MFA secret key id ${JSON.stringify(id)} must match ${KEY_ID_PATTERN}`,
        { field: "secrets.keys" },
      );
    }
    const bytes = toKeyBytes(material);
    if (bytes.byteLength !== 32) {
      throw new InvalidCredentialAuthDefinitionError(
        "SHIP_AUTH_KEY_INVALID",
        `MFA secret key ${JSON.stringify(id)} must be 32 bytes (hex, base64 or raw bytes)`,
        { field: "secrets.keys" },
      );
    }
    keys.set(id, bytes);
  }
  if (!keys.has(ring.current)) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_KEY_INVALID",
      `MFA secret current key ${JSON.stringify(ring.current)} is not in the key ring`,
      { field: "secrets.current" },
    );
  }
  const currentKeyId = ring.current;

  return Object.freeze({
    currentKeyId,
    encrypt(plaintext: string): string {
      const key = keys.get(currentKeyId) as Buffer;
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`${VERSION}.${currentKeyId}`, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        currentKeyId,
        nonce.toString("base64url"),
        body.toString("base64url"),
        tag.toString("base64url"),
      ].join(".");
    },
    decrypt(ciphertext: string): string {
      const parts = typeof ciphertext === "string" ? ciphertext.split(".") : [];
      if (parts.length !== 5 || parts[0] !== VERSION) {
        throw new TypeError("MFA secret ciphertext is malformed");
      }
      const [, keyId, nonce, body, tag] = parts as [string, string, string, string, string];
      const key = keys.get(keyId);
      if (!key) throw new TypeError(`MFA secret key ${JSON.stringify(keyId)} is not in the ring`);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAAD(Buffer.from(`${VERSION}.${keyId}`, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
    keyIdOf(ciphertext: string): string | undefined {
      const parts = typeof ciphertext === "string" ? ciphertext.split(".") : [];
      return parts.length === 5 && parts[0] === VERSION ? parts[1] : undefined;
    },
  });
}

function toKeyBytes(material: Uint8Array | string): Buffer {
  if (material instanceof Uint8Array) return Buffer.from(material);
  if (typeof material !== "string") return Buffer.alloc(0);
  if (/^[0-9a-fA-F]{64}$/u.test(material)) return Buffer.from(material, "hex");
  return Buffer.from(material, "base64");
}
