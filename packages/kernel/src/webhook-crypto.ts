/**
 * Edge-safe primitives for webhook verifiers.
 *
 * Every helper uses WebCrypto and byte arrays only, so the kernel and any
 * verifier built on it run unchanged on Node, Cloudflare Workers, and other
 * `globalThis.crypto` runtimes. Node's `node:crypto` is deliberately absent.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_PATTERN = /^[0-9a-fA-F]*$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export type WebhookHashAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Strict UTF-8 decoding; throws on invalid sequences instead of substituting. */
export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Returns undefined for odd-length or non-hex input rather than throwing. */
export function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !HEX_PATTERN.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Returns undefined for malformed standard base64 rather than throwing. */
export function base64ToBytes(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Length-independent constant-time comparison. Mismatched lengths still walk
 * the longer input so timing does not reveal where a prefix stopped matching.
 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function hmac(
  algorithm: WebhookHashAlgorithm,
  secret: string | Uint8Array,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    toBufferSource(typeof secret === "string" ? utf8Bytes(secret) : secret),
    { name: "HMAC", hash: { name: algorithm } },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    toBufferSource(typeof data === "string" ? utf8Bytes(data) : data),
  );
  return new Uint8Array(signature);
}

export async function digest(
  algorithm: WebhookHashAlgorithm,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const hashed = await globalThis.crypto.subtle.digest(
    algorithm,
    toBufferSource(typeof data === "string" ? utf8Bytes(data) : data),
  );
  return new Uint8Array(hashed);
}

/**
 * Parses an integer number of seconds (as provider signature headers carry)
 * into a Date, or undefined when the value is not a plain non-negative integer.
 */
export function unixSecondsToDate(value: string | undefined): Date | undefined {
  if (value === undefined || !/^\d{1,12}$/u.test(value)) return undefined;
  return new Date(Number.parseInt(value, 10) * 1000);
}

export function isWithinTolerance(timestamp: Date, now: Date, toleranceMs: number): boolean {
  return Math.abs(now.getTime() - timestamp.getTime()) <= toleranceMs;
}

/** Copies a byte view into a fresh ArrayBuffer-backed source WebCrypto accepts. */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
