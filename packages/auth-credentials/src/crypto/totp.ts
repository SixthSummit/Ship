import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface TotpOptions {
  /** Code length. Defaults to 6. */
  readonly digits?: number;
  /** Time step in seconds. Defaults to 30. */
  readonly periodSeconds?: number;
  /** HMAC algorithm. Defaults to `sha1`, what every authenticator app supports. */
  readonly algorithm?: "sha1" | "sha256" | "sha512";
}

export interface VerifyTotpOptions extends TotpOptions {
  readonly now: Date;
  /** Steps of clock drift accepted on either side. Defaults to 1. */
  readonly window?: number;
  /** The last step a code was accepted for; a code at or before it is a replay. */
  readonly lastUsedStep?: number;
}

/** 20 random bytes, the RFC 4226 recommended secret length, base32 for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The current step for a clock. */
export function totpStep(now: Date, periodSeconds = 30): number {
  return Math.floor(now.getTime() / 1000 / periodSeconds);
}

/** RFC 6238 code for one step (RFC 4226 dynamic truncation). */
export function totpCode(secret: string, step: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const algorithm = options.algorithm ?? "sha1";
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac(algorithm, base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Verifies a code within the drift window and returns the matching step, or
 * `undefined`. A step at or before `lastUsedStep` never matches, so a captured
 * code cannot be replayed within its validity window. Comparison is constant
 * time per candidate.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: VerifyTotpOptions,
): number | undefined {
  const digits = options.digits ?? 6;
  const window = options.window ?? 1;
  if (typeof code !== "string" || !/^\d+$/u.test(code) || code.length !== digits) return undefined;
  const current = totpStep(options.now, options.periodSeconds);
  const presented = Buffer.from(code, "utf8");
  let matched: number | undefined;
  for (let drift = -window; drift <= window; drift += 1) {
    const step = current + drift;
    if (options.lastUsedStep !== undefined && step <= options.lastUsedStep) continue;
    const expected = Buffer.from(totpCode(secret, step, options), "utf8");
    // Evaluate every candidate so timing does not reveal which step matched.
    if (expected.byteLength === presented.byteLength && timingSafeEqual(expected, presented)) {
      matched = matched ?? step;
    }
  }
  return matched;
}

/** The `otpauth://` URI authenticator apps enrol from. */
export function otpauthUrl(definition: {
  readonly issuer: string;
  readonly account: string;
  readonly secret: string;
  readonly digits?: number;
  readonly periodSeconds?: number;
  readonly algorithm?: "sha1" | "sha256" | "sha512";
}): string {
  const label = `${encodeURIComponent(definition.issuer)}:${encodeURIComponent(definition.account)}`;
  const query = new URLSearchParams({
    secret: definition.secret,
    issuer: definition.issuer,
    algorithm: (definition.algorithm ?? "sha1").toUpperCase(),
    digits: String(definition.digits ?? 6),
    period: String(definition.periodSeconds ?? 30),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(encoded: string): Uint8Array {
  const clean = encoded.toUpperCase().replace(/[=\s-]/gu, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new TypeError("value is not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}
