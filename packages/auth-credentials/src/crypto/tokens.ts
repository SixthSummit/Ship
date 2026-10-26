import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_TOKEN_PREFIX = "ship_s_";
export const CHALLENGE_TOKEN_PREFIX = "ship_c_";
export const ACTION_TOKEN_PREFIX = "ship_t_";

const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 256 random bits, base64url, behind a prefix that says what kind of token it is. */
export function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** True when the value has the prefix and exactly the body a generated token carries. */
export function isTokenShaped(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    TOKEN_BODY_PATTERN.test(value.slice(prefix.length))
  );
}

/**
 * What is stored for a token: its SHA-256 as hex. Tokens carry 256 bits of
 * entropy, so a plain hash (no salt, no stretching) is the right primitive;
 * the lookup is by hash and nothing in the database can be presented as the
 * token.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * One recovery code: 20 characters from a 31-symbol alphabet (about 99 bits)
 * in four groups, lowercase, without look-alike characters. Stored as a hash
 * like a token.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(20);
  let code = "";
  for (let index = 0; index < 20; index += 1) {
    if (index > 0 && index % 5 === 0) code += "-";
    code += RECOVERY_ALPHABET[(bytes[index] as number) % RECOVERY_ALPHABET.length];
  }
  return code;
}

/** Normalises what a person typed (case, spacing, dashes) before hashing. */
export function normalizeRecoveryCode(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return clean.replace(/(.{5})(?=.)/gu, "$1-");
}

export function hashRecoveryCode(code: string): string {
  return hashToken(normalizeRecoveryCode(code));
}

/** Constant-time string comparison for hashes and codes of equal length. */
export function constantTimeEqualStrings(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
