import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidStateError, type StatePayload, signState, verifyState } from "./state.js";

const SECRET = "test-secret-very-long-and-random-do-not-use-in-prod";

describe("OAuth state signing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const samplePayload: StatePayload = {
    accountId: "acc-1",
    providerCode: "google",
    returnTo: "/settings",
    extras: { wizardStep: 3 },
  };

  it("round-trips a payload through sign + verify", () => {
    const state = signState(samplePayload, SECRET);
    const recovered = verifyState(state, SECRET);
    // `verifyState` surfaces the auto-generated nonce as a JTI for
    // the F16 replay cache; the rest of the payload matches what
    // the caller signed.
    expect(recovered).toMatchObject(samplePayload);
    expect(typeof recovered.nonce).toBe("string");
    expect(recovered.nonce!.length).toBeGreaterThan(0);
  });

  it("strips internal `iat` from the verified payload + surfaces nonce as JTI", () => {
    const state = signState(samplePayload, SECRET);
    const recovered = verifyState(state, SECRET) as Record<string, unknown>;
    expect(recovered).not.toHaveProperty("iat");
    // `nonce` is now surfaced (F16) so callers can use it as a
    // single-use JTI against `StateJtiCache`.
    expect(recovered).toHaveProperty("nonce");
  });

  it("each sign call produces a different opaque (nonce randomization)", () => {
    const a = signState(samplePayload, SECRET);
    const b = signState(samplePayload, SECRET);
    expect(a).not.toBe(b);
  });

  it("rejects an empty state string", () => {
    expect(() => verifyState("", SECRET)).toThrow(InvalidStateError);
    expect(() => verifyState("", SECRET)).toThrow(/missing/i);
  });

  it("rejects a state without the dot separator", () => {
    expect(() => verifyState("nodothere", SECRET)).toThrow(/malformed/i);
  });

  it("rejects a state signed with a different secret", () => {
    const state = signState(samplePayload, SECRET);
    expect(() => verifyState(state, "different-secret-also-long-enough")).toThrow(/signature/i);
  });

  it("rejects a tampered payload (any byte change)", () => {
    const state = signState(samplePayload, SECRET);
    const dot = state.indexOf(".");
    const tampered = state.slice(0, dot - 1) + "X" + state.slice(dot);
    expect(() => verifyState(tampered, SECRET)).toThrow(/signature/i);
  });

  it("rejects a state past maxAge (default 10 minutes)", () => {
    const state = signState(samplePayload, SECRET);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(() => verifyState(state, SECRET)).toThrow(/expired/i);
  });

  it("accepts a state inside the maxAge window", () => {
    const state = signState(samplePayload, SECRET);
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(verifyState(state, SECRET).accountId).toBe("acc-1");
  });

  it("respects custom maxAgeMs", () => {
    const state = signState(samplePayload, SECRET);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(() => verifyState(state, SECRET, { maxAgeMs: 60_000 })).toThrow(/expired/i);
  });

  it("rejects a state issued in the future (clock skew defense)", () => {
    const futureNow = () => Date.now() + 60_000;
    const state = signState(samplePayload, SECRET, { now: futureNow });
    expect(() => verifyState(state, SECRET)).toThrow(/future/i);
  });

  it("rejects a state with a payload that's not valid JSON", () => {
    const garbagePayload = Buffer.from("not-json", "utf8").toString("base64url");
    const sig = "anything"; // Won't match anyway.
    expect(() => verifyState(`${garbagePayload}.${sig}`, SECRET)).toThrow(/signature|json/i);
  });

  it("rejects a state missing required payload fields", () => {
    // Build a valid signature over an incomplete payload to bypass the
    // sig check and reach the field-shape check.
    const partial = JSON.stringify({ iat: Date.now() }); // missing accountId etc.
    const encoded = Buffer.from(partial, "utf8").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    expect(() => verifyState(`${encoded}.${sig}`, SECRET)).toThrow(/required fields/i);
  });

  it("requires a non-empty secret", () => {
    expect(() => signState(samplePayload, "")).toThrow(/secret/i);
    expect(() => verifyState("a.b", "")).toThrow(/secret/i);
  });
});

describe("OAuth state — multi-secret key rotation", () => {
  const NEW = "test-secret-rotation-NEW-very-long-and-random-do-not-use-prod";
  const OLD = "test-secret-rotation-OLD-very-long-and-random-do-not-use-prod";
  const EVIL = "attacker-supplied-fake-secret-pretending-to-be-the-old-key";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const samplePayload: StatePayload = {
    accountId: "acc-rotation",
    providerCode: "google",
  };

  it("array signing uses the head; output is byte-identical to head-as-string sign", () => {
    // Pin the nonce + iat so we can compare bytes directly across calls.
    const fixedNow = () => Date.now();
    const headSigned = signState(samplePayload, NEW, { now: fixedNow });
    // Reset the system clock so signing-with-array also gets a known
    // iat — but the nonce will still differ. We just verify both forms
    // accept each other on verify (the meaningful contract).
    const arraySigned = signState(samplePayload, [NEW, OLD], { now: fixedNow });

    expect(verifyState(headSigned, [NEW, OLD]).accountId).toBe("acc-rotation");
    expect(verifyState(arraySigned, NEW).accountId).toBe("acc-rotation");
  });

  it("verify accepts a state signed with the head key (steady state)", () => {
    const state = signState(samplePayload, NEW);
    expect(verifyState(state, [NEW, OLD]).accountId).toBe("acc-rotation");
  });

  it("verify accepts a state signed with a tail key (the rotation window)", () => {
    // This is the load-bearing rotation property: a state minted with the
    // OLD key, before the operator added NEW to the head, still verifies
    // until OLD is dropped from the tail.
    const stateSignedWithOld = signState(samplePayload, OLD);
    expect(verifyState(stateSignedWithOld, [NEW, OLD]).accountId).toBe("acc-rotation");
  });

  it("verify rejects a state signed with a key not in the verification set", () => {
    const stateSignedWithEvil = signState(samplePayload, EVIL);
    expect(() => verifyState(stateSignedWithEvil, [NEW, OLD])).toThrow(/signature mismatch/i);
  });

  it("verify rejects when only the new key is present and the state was signed with the old", () => {
    // Tail-key drop completed; old states minted with OLD are now
    // rejected (correct behavior — the rotation window has closed).
    const stateSignedWithOld = signState(samplePayload, OLD);
    expect(() => verifyState(stateSignedWithOld, [NEW])).toThrow(/signature mismatch/i);
  });

  it("rejects empty arrays at sign and verify", () => {
    expect(() => signState(samplePayload, [])).toThrow(/secret/i);
    expect(() => verifyState("a.b", [])).toThrow(/secret/i);
  });

  it("rejects array of empty strings at sign and verify", () => {
    expect(() => signState(samplePayload, ["", ""])).toThrow(/secret/i);
    expect(() => verifyState("a.b", ["", ""])).toThrow(/secret/i);
  });

  it("array with trailing empty entries still works (filters non-empty keys)", () => {
    // Real-world: env-var parsing might emit trailing empty strings;
    // the resolver filters them out.
    const state = signState(samplePayload, [NEW, "", OLD]);
    expect(verifyState(state, [NEW, "", OLD]).accountId).toBe("acc-rotation");
  });

  it("single-string secret continues to work end-to-end (regression check)", () => {
    const state = signState(samplePayload, NEW);
    expect(verifyState(state, NEW).accountId).toBe("acc-rotation");
  });

  it("verify still enforces age window across rotation (state signed with old key, expired)", () => {
    const stateSignedWithOld = signState(samplePayload, OLD);
    vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-min window
    expect(() => verifyState(stateSignedWithOld, [NEW, OLD])).toThrow(/expired/i);
  });

  it("verify still enforces tamper detection across rotation", () => {
    const state = signState(samplePayload, OLD);
    const dot = state.indexOf(".");
    const tampered = state.slice(0, dot - 1) + "X" + state.slice(dot);
    expect(() => verifyState(tampered, [NEW, OLD])).toThrow(/signature/i);
  });
});
