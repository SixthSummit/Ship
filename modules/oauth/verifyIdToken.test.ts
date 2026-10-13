import { AuthenticationError } from "@sixthsummit/ship-api/http/errors/AuthenticationError";
import type { JWK } from "jose";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _internals, verifyIdToken } from "./verifyIdToken.js";

/**
 * Mint synthetic id_tokens via `jose`, hand the helper a local
 * JWKS built from the matching public key so production's
 * `createRemoteJWKSet` HTTP fetch is sidestepped entirely.
 */

const ISSUER = "https://test-provider.example/oidc";
const AUDIENCE = "test-client-id";
const NONCE = "nonce-from-state-abc123";

interface KeyMaterial {
  publicJwk: JWK;
  privateKey: CryptoKey;
  kid: string;
}

async function makeKey(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  return { publicJwk, privateKey, kid };
}

async function mint(
  key: KeyMaterial,
  claims: Record<string, unknown>,
  opts: { expSec?: number; iatSec?: number } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    nonce: NONCE,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(opts.iatSec ?? nowSec)
    .setExpirationTime(opts.expSec ?? nowSec + 3600);
  return await builder.sign(key.privateKey);
}

describe("verifyIdToken (F13)", () => {
  let key: KeyMaterial;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeEach(async () => {
    key = await makeKey("kid-1");
    jwks = createLocalJWKSet({ keys: [key.publicJwk] });
  });

  afterEach(() => {
    _internals.jwksCache.clear();
  });

  it("verifies a well-formed id_token with matching nonce + iss + aud", async () => {
    const token = await mint(key, { sub: "user-1" });
    const payload = await verifyIdToken({
      idToken: token,
      key: jwks,
      expectedNonce: NONCE,
      expectedIssuer: ISSUER,
      expectedAudience: AUDIENCE,
    });
    expect(payload.sub).toBe("user-1");
    expect(payload.nonce).toBe(NONCE);
  });

  it("rejects when the nonce in the id_token doesn't match expectedNonce", async () => {
    const token = await mint(key, { sub: "user-1", nonce: "wrong-nonce" });
    await expect(
      verifyIdToken({
        idToken: token,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it("rejects when the id_token is missing a nonce claim entirely", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(key.privateKey);

    await expect(
      verifyIdToken({
        idToken: token,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/missing nonce/);
  });

  it("rejects when the issuer doesn't match", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "u", nonce: NONCE })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer("https://attacker.example/")
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(key.privateKey);

    await expect(
      verifyIdToken({
        idToken: token,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/claim invalid/i);
  });

  it("rejects when the audience doesn't match", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "u", nonce: NONCE })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(ISSUER)
      .setAudience("different-client-id")
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(key.privateKey);

    await expect(
      verifyIdToken({
        idToken: token,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/claim invalid/i);
  });

  it("rejects an expired id_token (outside default 30s tolerance)", async () => {
    const expiredSec = Math.floor(Date.now() / 1000) - 3600;
    const token = await mint(key, { sub: "u" }, { iatSec: expiredSec - 60, expSec: expiredSec });
    await expect(
      verifyIdToken({
        idToken: token,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/expired/i);
  });

  it("rejects when the signature is wrong (different key)", async () => {
    const otherKey = await makeKey("kid-other");
    // Mint with the wrong private key — JWKS only carries our trusted public key.
    const token = await mint(otherKey, { sub: "u" });
    await expect(
      verifyIdToken({
        idToken: token,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/no matching JWKS key|signature/i);
  });

  it("throws on missing required inputs", async () => {
    await expect(
      verifyIdToken({
        idToken: "",
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/missing idToken/);

    const validToken = await mint(key, { sub: "u" });
    await expect(
      verifyIdToken({
        idToken: validToken,
        key: jwks,
        expectedNonce: "",
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/expectedNonce/);
    await expect(
      verifyIdToken({
        idToken: validToken,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: "",
        expectedAudience: AUDIENCE,
      }),
    ).rejects.toThrow(/expectedIssuer/);
    await expect(
      verifyIdToken({
        idToken: validToken,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: "",
      }),
    ).rejects.toThrow(/expectedAudience/);
  });

  it("the resulting error is an AuthenticationError (mapped to 401 by framework)", async () => {
    const token = await mint(key, { sub: "u", nonce: "wrong" });
    try {
      await verifyIdToken({
        idToken: token,
        key: jwks,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationError);
    }
  });

  it("memoizes the JWKS instance when called with a URI string", async () => {
    const uri = "https://example.test/jwks.json";
    expect(_internals.jwksCache.has(uri)).toBe(false);
    // Trigger the URL-string code path; the underlying fetch will
    // fail (no real provider) but the cache should still gain an
    // entry before that happens.
    try {
      await verifyIdToken({
        idToken: await mint(key, { sub: "u" }),
        key: uri,
        expectedNonce: NONCE,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
      });
    } catch {
      // expected — the fetch fails
    }
    expect(_internals.jwksCache.has(uri)).toBe(true);
  });
});
