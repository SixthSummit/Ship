import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque state primitive for the OAuth `state` parameter.
 *
 * The framework owns this end-to-end: adapters round-trip the string
 * verbatim, never inspect it. The routes layer:
 *
 *   1. Builds a `StatePayload` describing what user is connecting and
 *      to which provider.
 *   2. Calls `signState(payload, secret)` → opaque token to embed in
 *      the authorize URL.
 *   3. On callback, calls `verifyState(state, secret)` → recovers the
 *      payload, throws on tamper / expiry.
 *
 * Encoding: `base64url(payloadJson) . base64url(hmacSha256(payloadJson, secret))`
 *
 * Why HMAC-SHA256 instead of ES256/JWT:
 *   - State payloads are tiny (account-id + provider + nonce + ts);
 *     JWT's overhead doesn't add value.
 *   - HMAC-SHA256 is timing-safe-comparable in stdlib without
 *     additional ceremony.
 *   - No external key-rotation infrastructure needed; secret comes
 *     from the framework's existing JWT signing-key plumbing.
 *
 * Replay protection: timestamp window (default 10 minutes). The OAuth
 * `code` itself is single-use at the provider — the upstream rejects
 * code reuse even if state were replayable. The window is the
 * defense against a leaked state being used minutes later by the
 * attacker before the legitimate user finishes the flow.
 *
 * Tamper protection: HMAC over the full payload-JSON. Any byte change
 * in the encoded payload fails verification.
 */

export interface StatePayload {
  /** Framework-owned subject — typically `accounts.id`. */
  accountId: string;
  /** Provider being connected, matches `providerCode` on the connection row. */
  providerCode: string;
  /**
   * Caller-defined return-target after callback completes (e.g. the
   * page the user was on when they hit "connect"). Sanitize at the
   * routes layer before redirecting.
   */
  returnTo?: string;
  /**
   * Free-form caller-defined extras the framework round-trips. Used
   * by routes that initiate OAuth as part of a larger flow (e.g.
   * onboarding wizard step IDs).
   */
  extras?: Record<string, unknown>;
  /**
   * PKCE code-verifier (raw, base64url-encoded, 43–128 chars). The
   * framework generates this in the authorize handler, derives the
   * SHA-256 challenge for the upstream provider, and signs the
   * verifier into state so the callback can pass it back to the
   * adapter's `exchangeCodeForTokens` (F12).
   */
  codeVerifier?: string;
  /**
   * Per-state opaque nonce, populated by `signState` (16 random
   * base64url bytes). `signState` ignores this when supplied by
   * the caller — it always generates a fresh nonce. `verifyState`
   * surfaces the recovered nonce so the routes layer can use it as
   * a single-use JTI against a short-TTL replay cache (F16).
   */
  nonce?: string;
}

interface SignedStatePayload extends StatePayload {
  /** Issued-at unix milliseconds. */
  iat: number;
  /** Opaque random nonce — defends against replay within the window. */
  nonce: string;
}

export class InvalidStateError extends Error {
  constructor(reason: string) {
    super(`OAuth state invalid: ${reason}`);
    this.name = "InvalidStateError";
  }
}

export interface SignStateOptions {
  /** Override the unix-ms-now used for `iat`. Tests inject a fixed clock. */
  now?: () => number;
}

export interface VerifyStateOptions {
  /**
   * Acceptable age in milliseconds. Default 10 minutes. The state is
   * rejected when (now - iat) exceeds this.
   */
  maxAgeMs?: number;
  /** Override the now-source. Tests pin time. */
  now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * State-signing secret. A single string is the simple path; an ordered
 * array enables zero-downtime rotation — the **head** is the active
 * signing key, every entry is accepted on verify. Standard rotation
 * pattern:
 *
 *   1. Prepend the new key to the head: `[ "new", "old" ]`.
 *   2. Wait at least `maxAgeMs` (default 10 minutes) for any in-flight
 *      old-key states to expire.
 *   3. Drop the old key from the tail: `[ "new" ]`.
 *
 * `defineEnv` is the boundary that turns env vars into this shape;
 * consumers typically expose `OAUTH_STATE_SECRET` as a single string
 * during steady-state and switch to a JSON-array env (or split into
 * `OAUTH_STATE_SECRET_NEW` + `OAUTH_STATE_SECRET_OLD` parsed into an
 * array in `environment.ts`) during a rotation window.
 */
export type StateSecret = string | readonly string[];

/**
 * Returns the head (active signing) key. Throws when no usable key is
 * available — empty string, empty array, or array of empty strings.
 */
function resolveSigningKey(secret: StateSecret): string {
  if (typeof secret === "string") {
    if (!secret) throw new Error("signState: secret is required");
    return secret;
  }
  for (const candidate of secret) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  throw new Error("signState: secret is required");
}

/**
 * Returns every non-empty key in the verification set, head first.
 * Throws when the set is empty (same error as v0.1's single-string
 * "secret is required" path so existing callers see a familiar error).
 */
function resolveVerificationKeys(secret: StateSecret): readonly string[] {
  if (typeof secret === "string") {
    if (!secret) throw new Error("verifyState: secret is required");
    return [secret];
  }
  const out = secret.filter((k) => typeof k === "string" && k.length > 0);
  if (out.length === 0) throw new Error("verifyState: secret is required");
  return out;
}

export function signState(
  payload: StatePayload,
  secret: StateSecret,
  opts: SignStateOptions = {},
): string {
  const signingKey = resolveSigningKey(secret);
  const now = opts.now?.() ?? Date.now();
  const signed: SignedStatePayload = {
    ...payload,
    iat: now,
    nonce: randomBytes(16).toString("base64url"),
  };
  const json = JSON.stringify(signed);
  const payloadEncoded = Buffer.from(json, "utf8").toString("base64url");
  const sig = createHmac("sha256", signingKey).update(payloadEncoded).digest("base64url");
  return `${payloadEncoded}.${sig}`;
}

export function verifyState(
  state: string,
  secret: StateSecret,
  opts: VerifyStateOptions = {},
): StatePayload {
  if (!state) throw new InvalidStateError("missing state");
  const verificationKeys = resolveVerificationKeys(secret);

  const dot = state.indexOf(".");
  if (dot === -1) throw new InvalidStateError("malformed state");
  const payloadEncoded = state.slice(0, dot);
  const sigSupplied = state.slice(dot + 1);
  const supplied = Buffer.from(sigSupplied, "base64url");

  // Iterate every key to completion even after a match. Short-circuiting
  // on first match would leak via wall-clock timing which position in
  // the rotation set matched — narrowing the search for any known-leaked
  // tail key. The keyset is small (1–3 in practice) and HMAC-SHA256 over
  // a ~1KB payload is microseconds; the cost of constant-time is
  // negligible. Per-iteration HMAC compare is already timing-safe via
  // `timingSafeEqual`; this loop wraps it in a constant-iteration outer.
  let matched = false;
  for (const key of verificationKeys) {
    const expected = createHmac("sha256", key).update(payloadEncoded).digest("base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes)) {
      matched = true;
      // No `break` — keep iterating to flatten the timing profile.
    }
  }
  if (!matched) {
    throw new InvalidStateError("signature mismatch");
  }

  let parsed: SignedStatePayload;
  try {
    const json = Buffer.from(payloadEncoded, "base64url").toString("utf8");
    parsed = JSON.parse(json) as SignedStatePayload;
  } catch {
    throw new InvalidStateError("payload not valid JSON");
  }

  if (
    typeof parsed.accountId !== "string" ||
    typeof parsed.providerCode !== "string" ||
    typeof parsed.iat !== "number" ||
    typeof parsed.nonce !== "string"
  ) {
    throw new InvalidStateError("payload missing required fields");
  }

  const now = opts.now?.() ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const age = now - parsed.iat;
  if (age < 0) throw new InvalidStateError("state issued in the future");
  if (age > maxAgeMs) throw new InvalidStateError("state expired");

  return {
    accountId: parsed.accountId,
    providerCode: parsed.providerCode,
    returnTo: parsed.returnTo,
    extras: parsed.extras,
    codeVerifier: parsed.codeVerifier,
    nonce: parsed.nonce,
  };
}
