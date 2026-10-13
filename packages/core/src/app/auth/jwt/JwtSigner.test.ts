import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "../../../http/errors/AuthenticationError.js";
import { JwtSigner, type JwtSigningKey, type JwtVerificationKey } from "./JwtSigner.js";

interface KeyMaterial {
  kid: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

async function makeKey(kid: string): Promise<KeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  return { kid, publicKey, privateKey };
}

let keyA: KeyMaterial;
let keyB: KeyMaterial;
beforeAll(async () => {
  keyA = await makeKey("kid-a");
  keyB = await makeKey("kid-b");
});

function signer(opts: {
  signing?: KeyMaterial;
  verification?: KeyMaterial[];
  issuer?: string;
  audience?: string;
  clockToleranceSec?: number;
}) {
  const sk = opts.signing ?? keyA;
  const vks = opts.verification ?? [keyA];
  return new JwtSigner({
    signingKey: { kid: sk.kid, privateKey: sk.privateKey } satisfies JwtSigningKey,
    verificationKeys: vks.map(
      (k) => ({ kid: k.kid, publicKey: k.publicKey }) satisfies JwtVerificationKey,
    ),
    issuer: opts.issuer,
    audience: opts.audience,
    clockToleranceSec: opts.clockToleranceSec,
  });
}

afterEach(() => vi.useRealTimers());

describe("JwtSigner — construction", () => {
  it("rejects an empty verificationKeys array", () => {
    expect(
      () =>
        new JwtSigner({
          signingKey: { kid: keyA.kid, privateKey: keyA.privateKey },
          verificationKeys: [],
        }),
    ).toThrow(/at least one key/);
  });

  it("rejects a signing kid not present in verificationKeys", () => {
    expect(() => signer({ signing: keyA, verification: [keyB] })).toThrow(
      /missing from verificationKeys/,
    );
  });

  it("rejects duplicate verification kids", () => {
    expect(
      () =>
        new JwtSigner({
          signingKey: { kid: keyA.kid, privateKey: keyA.privateKey },
          verificationKeys: [
            { kid: keyA.kid, publicKey: keyA.publicKey },
            { kid: keyA.kid, publicKey: keyA.publicKey },
          ],
        }),
    ).toThrow(/duplicate verification key/);
  });
});

describe("JwtSigner — sign + verify round-trip", () => {
  it("signs with the active kid and verifies via the matching public key", async () => {
    const s = signer({ signing: keyA, verification: [keyA] });
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });
    expect(signed.kid).toBe(keyA.kid);
    expect(signed.token.split(".").length).toBe(3);

    const verified = await s.verify(signed.token);
    expect(verified.payload.sub).toBe("user-1");
    expect(verified.payload.jti).toBe(signed.jti);
    expect(verified.kid).toBe(keyA.kid);
  });

  it("auto-generates a UUIDv4 jti when none is supplied", async () => {
    const s = signer({});
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });
    // RFC 4122 v4 — `4` in the version nibble, `8`/`9`/`a`/`b` in the variant nibble.
    expect(signed.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("respects an explicit jti override", async () => {
    const s = signer({});
    const signed = await s.sign({ subject: "user-1", ttlSec: 60, jti: "fixed-jti" });
    const verified = await s.verify(signed.token);
    expect(verified.payload.jti).toBe("fixed-jti");
  });

  it("threads custom claims through the JWT payload", async () => {
    const s = signer({});
    const signed = await s.sign({
      subject: "user-1",
      ttlSec: 60,
      claims: { roles: ["admin"], tenant: "t1" },
    });
    const verified = await s.verify(signed.token);
    expect(verified.payload.roles).toEqual(["admin"]);
    expect(verified.payload.tenant).toBe("t1");
  });

  it("enforces issuer when configured", async () => {
    const s = signer({ issuer: "ship-api" });
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });
    const verified = await s.verify(signed.token);
    expect(verified.payload.iss).toBe("ship-api");
  });

  it("rejects a token whose iss does not match", async () => {
    const issuing = signer({ issuer: "ship-api" });
    const verifying = signer({ issuer: "other" });
    const signed = await issuing.sign({ subject: "user-1", ttlSec: 60 });
    await expect(verifying.verify(signed.token)).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("JwtSigner — failure modes", () => {
  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const s = signer({});
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });

    vi.setSystemTime(new Date("2026-01-01T00:02:00Z")); // 2 minutes later — past 60s TTL
    await expect(s.verify(signed.token)).rejects.toThrow(/expired/i);
  });

  it("rejects a token signed by an unknown kid", async () => {
    const issuingOnly = signer({ signing: keyB, verification: [keyB] });
    const verifyingOnly = signer({ signing: keyA, verification: [keyA] });
    const signed = await issuingOnly.sign({ subject: "user-1", ttlSec: 60 });
    await expect(verifyingOnly.verify(signed.token)).rejects.toThrow(/signing key not recognized/);
  });

  it("rejects a tampered signature", async () => {
    const s = signer({});
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });
    const [h, p] = signed.token.split(".");
    // Replace the signature with a wrong one of the same length.
    const tampered = `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(s.verify(tampered)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token signed without a kid header", async () => {
    const s = signer({});
    const tokenNoKid = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(keyA.privateKey);
    await expect(s.verify(tokenNoKid)).rejects.toThrow(/kid/i);
  });

  it("rejects a non-JWS string", async () => {
    const s = signer({});
    await expect(s.verify("not-a-jwt")).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("JwtSigner — key rotation", () => {
  it("verifies tokens signed by a retiring key while the new key is active", async () => {
    // Rotation timeline:
    //   1. Originally signing with keyA. verificationKeys = [keyA].
    //   2. Add keyB to verificationKeys. Still signing with keyA.
    //   3. Cut signing over to keyB. verificationKeys = [keyA, keyB].
    //   4. Wait > max access-token TTL.
    //   5. Drop keyA from verificationKeys.
    //
    // Tokens issued at step 1-3 must verify at step 3 (the dual-key window).

    const oldSigner = signer({ signing: keyA, verification: [keyA] });
    const oldToken = await oldSigner.sign({ subject: "user-1", ttlSec: 600 });

    const dualKeyWindow = signer({ signing: keyB, verification: [keyA, keyB] });
    const verifiedOld = await dualKeyWindow.verify(oldToken.token);
    expect(verifiedOld.kid).toBe(keyA.kid);

    const newToken = await dualKeyWindow.sign({ subject: "user-1", ttlSec: 600 });
    expect(newToken.kid).toBe(keyB.kid);
    const verifiedNew = await dualKeyWindow.verify(newToken.token);
    expect(verifiedNew.kid).toBe(keyB.kid);
  });

  it("rejects an old-key-signed token after the retiring key is removed", async () => {
    const dualKeyWindow = signer({ signing: keyB, verification: [keyA, keyB] });
    const oldToken = await dualKeyWindow.sign({ subject: "user-1", ttlSec: 600 });
    // Override signing kid back to keyA so the token carries kid-a.
    const oldSigner = signer({ signing: keyA, verification: [keyA, keyB] });
    const reIssuedOld = await oldSigner.sign({ subject: "user-1", ttlSec: 600 });
    expect(reIssuedOld.kid).toBe(keyA.kid);

    const postRotation = signer({ signing: keyB, verification: [keyB] });
    await expect(postRotation.verify(reIssuedOld.token)).rejects.toThrow(
      /signing key not recognized/,
    );

    // Sanity — the new-key token from before rotation still verifies.
    const stillValid = await postRotation.verify(oldToken.token);
    expect(stillValid.kid).toBe(keyB.kid);
  });

  it("exposes signing + verification kids for introspection", () => {
    const s = signer({ signing: keyA, verification: [keyA, keyB] });
    expect(s.getSigningKid()).toBe(keyA.kid);
    expect(s.getVerificationKids().sort()).toEqual([keyA.kid, keyB.kid].sort());
  });
});

describe("JwtSigner — clockToleranceSec default (F9)", () => {
  it("accepts a token verified 25s past its exp under the default tolerance (30s)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const s = signer({}); // no explicit tolerance → defaults to 30s
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });

    // Move clock to 25s past expiry (signed.expiresAt + 25s).
    vi.setSystemTime((signed.expiresAt + 25) * 1000);
    const verified = await s.verify(signed.token);
    expect(verified.payload.sub).toBe("user-1");
  });

  it("rejects a token verified 35s past its exp (outside the default tolerance)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const s = signer({});
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });

    vi.setSystemTime((signed.expiresAt + 35) * 1000);
    await expect(s.verify(signed.token)).rejects.toThrow(/expired/i);
  });

  it("explicit clockToleranceSec: 0 reproduces the prior strict behavior", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const s = signer({ clockToleranceSec: 0 });
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });

    // Even 1s past expiry → reject under strict mode.
    vi.setSystemTime((signed.expiresAt + 1) * 1000);
    await expect(s.verify(signed.token)).rejects.toThrow(/expired/i);
  });

  it("explicit larger tolerance still honored (e.g. 120s for high-skew environments)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const s = signer({ clockToleranceSec: 120 });
    const signed = await s.sign({ subject: "user-1", ttlSec: 60 });

    vi.setSystemTime((signed.expiresAt + 100) * 1000);
    const verified = await s.verify(signed.token);
    expect(verified.payload.sub).toBe("user-1");
  });
});
