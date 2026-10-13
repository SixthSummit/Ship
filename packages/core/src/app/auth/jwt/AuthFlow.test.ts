import { generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "../../../http/errors/AuthenticationError.js";
import { AuthFlow } from "./AuthFlow.js";
import { JwtSigner } from "./JwtSigner.js";
import { hashRefreshToken, InMemoryRefreshTokenStore } from "./RefreshTokenStore.js";

let publicKey: CryptoKey;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  privateKey = pair.privateKey;
});

function buildFlow(opts: { accessTtlSec?: number; refreshTtlSec?: number } = {}) {
  const signer = new JwtSigner({
    signingKey: { kid: "k1", privateKey },
    verificationKeys: [{ kid: "k1", publicKey }],
    issuer: "ship-api-test",
  });
  const store = new InMemoryRefreshTokenStore();
  const flow = new AuthFlow({
    signer,
    refreshTokenStore: store,
    accessTokenTtlSec: opts.accessTtlSec ?? 60,
    refreshTokenTtlSec: opts.refreshTtlSec ?? 86_400,
  });
  return { flow, signer, store };
}

afterEach(() => vi.useRealTimers());

describe("AuthFlow.issue", () => {
  it("returns a verifiable access JWT plus an opaque refresh token", async () => {
    const { flow } = buildFlow();
    const pair = await flow.issue({ accountId: "acct-1" });

    expect(pair.accessToken.split(".").length).toBe(3);
    expect(pair.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.refreshTokenId).toBeTruthy();

    const verified = await flow.verifyAccess(pair.accessToken);
    expect(verified.payload.sub).toBe("acct-1");
  });

  it("persists the refresh token under its hash, never the raw value", async () => {
    const { flow, store } = buildFlow();
    const pair = await flow.issue({ accountId: "acct-1" });

    const byHash = await store.findByHash(hashRefreshToken(pair.refreshToken));
    expect(byHash).not.toBeNull();
    expect(byHash!.id).toBe(pair.refreshTokenId);
    // Sanity — looking up by raw value (i.e., not hashed) must NOT find a row.
    const byRaw = await store.findByHash(pair.refreshToken);
    expect(byRaw).toBeNull();
  });

  it("threads custom claims into the access token", async () => {
    const { flow } = buildFlow();
    const pair = await flow.issue({
      accountId: "acct-1",
      claims: { tenant: "t-9", roles: ["admin"] },
    });
    const verified = await flow.verifyAccess(pair.accessToken);
    expect(verified.payload.tenant).toBe("t-9");
    expect(verified.payload.roles).toEqual(["admin"]);
  });

  it("captures audit context (userAgent, ip) on the refresh row", async () => {
    const { flow, store } = buildFlow();
    const pair = await flow.issue({
      accountId: "acct-1",
      userAgent: "Mozilla/5.0",
      ip: "1.2.3.4",
    });
    const row = await store.findByHash(hashRefreshToken(pair.refreshToken));
    expect(row!.userAgent).toBe("Mozilla/5.0");
    expect(row!.issuedFromIp).toBe("1.2.3.4");
  });
});

describe("AuthFlow.rotate — happy path", () => {
  it("exchanges a presented refresh token for a new pair and links the chain", async () => {
    const { flow, store } = buildFlow();
    const first = await flow.issue({ accountId: "acct-1" });
    const second = await flow.rotate(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.refreshTokenId).not.toBe(first.refreshTokenId);

    // First row now has replacedById -> second.
    const firstRow = await store.findByHash(hashRefreshToken(first.refreshToken));
    expect(firstRow!.replacedById).toBe(second.refreshTokenId);
    // Second row is fresh.
    const secondRow = await store.findByHash(hashRefreshToken(second.refreshToken));
    expect(secondRow!.replacedById).toBeNull();
    expect(secondRow!.revokedAt).toBeNull();
  });

  it("issues an access token that verifies after rotation", async () => {
    const { flow } = buildFlow();
    const first = await flow.issue({ accountId: "acct-1" });
    const second = await flow.rotate(first.refreshToken);
    const verified = await flow.verifyAccess(second.accessToken);
    expect(verified.payload.sub).toBe("acct-1");
  });
});

describe("AuthFlow.rotate — reuse detection (load-bearing security property)", () => {
  it("rotating a token whose successor already exists revokes the entire chain", async () => {
    const { flow, store } = buildFlow();
    // Legitimate path: issue → rotate. The first refresh token now has
    // replacedById set. The legitimate user discards `first` and uses `second`.
    const first = await flow.issue({ accountId: "acct-1" });
    const second = await flow.rotate(first.refreshToken);

    // Attacker (or buggy client) presents `first` — the original — *after* it's been rotated.
    await expect(flow.rotate(first.refreshToken)).rejects.toThrow(/reuse detected/);

    // Both rows in the chain are now revoked.
    const firstRow = await store.findByHash(hashRefreshToken(first.refreshToken));
    const secondRow = await store.findByHash(hashRefreshToken(second.refreshToken));
    expect(firstRow!.revokedAt).toBeInstanceOf(Date);
    expect(secondRow!.revokedAt).toBeInstanceOf(Date);

    // And `second` (the legitimate-user's "current" token) can no longer rotate.
    await expect(flow.rotate(second.refreshToken)).rejects.toThrow(/revoked/);
  });

  it("rotating a revoked token also kills the chain", async () => {
    const { flow, store } = buildFlow();
    const first = await flow.issue({ accountId: "acct-1" });
    await flow.revoke(first.refreshToken);
    await expect(flow.rotate(first.refreshToken)).rejects.toThrow(/revoked/);

    const row = await store.findByHash(hashRefreshToken(first.refreshToken));
    expect(row!.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects an unknown refresh token without leaking whether it ever existed", async () => {
    const { flow } = buildFlow();
    await expect(flow.rotate("never-issued-token")).rejects.toThrow(/invalid/);
  });

  it("rejects an expired refresh token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { flow } = buildFlow({ refreshTtlSec: 60 });
    const first = await flow.issue({ accountId: "acct-1" });
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    await expect(flow.rotate(first.refreshToken)).rejects.toThrow(/expired/);
  });
});

describe("AuthFlow.revoke", () => {
  it("revoking is idempotent and silent on unknown tokens", async () => {
    const { flow, store } = buildFlow();
    const first = await flow.issue({ accountId: "acct-1" });

    await flow.revoke(first.refreshToken);
    await flow.revoke(first.refreshToken); // second call must not throw
    await flow.revoke("unknown-token");

    const row = await store.findByHash(hashRefreshToken(first.refreshToken));
    expect(row!.revokedAt).toBeInstanceOf(Date);
  });
});

describe("AuthFlow.revokeAccount", () => {
  it("revokes every active refresh token for the account; returns the count", async () => {
    const { flow, store } = buildFlow();
    const a = await flow.issue({ accountId: "acct-1" });
    const b = await flow.issue({ accountId: "acct-1" });
    const c = await flow.issue({ accountId: "acct-2" });

    const count = await flow.revokeAccount("acct-1");
    expect(count).toBe(2);

    expect((await store.findByHash(hashRefreshToken(a.refreshToken)))!.revokedAt).toBeInstanceOf(
      Date,
    );
    expect((await store.findByHash(hashRefreshToken(b.refreshToken)))!.revokedAt).toBeInstanceOf(
      Date,
    );
    expect((await store.findByHash(hashRefreshToken(c.refreshToken)))!.revokedAt).toBeNull();
  });
});

describe("AuthFlow.verifyAccess — failure surfaces as AuthenticationError", () => {
  it("rejects a malformed access token", async () => {
    const { flow } = buildFlow();
    await expect(flow.verifyAccess("not-a-jwt")).rejects.toBeInstanceOf(AuthenticationError);
  });
});
