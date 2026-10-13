import { describe, expect, it } from "vitest";
import {
  generateRefreshTokenValue,
  hashRefreshToken,
  InMemoryRefreshTokenStore,
  type IssueRefreshTokenInput,
} from "./RefreshTokenStore.js";

function input(overrides: Partial<IssueRefreshTokenInput> = {}): IssueRefreshTokenInput {
  return {
    accountId: "acct-1",
    tokenHash: hashRefreshToken("raw-1"),
    expiresAt: new Date(Date.now() + 60_000),
    userAgent: "vitest",
    issuedFromIp: "127.0.0.1",
    ...overrides,
  };
}

describe("hashRefreshToken / generateRefreshTokenValue", () => {
  it("hashRefreshToken produces a deterministic 64-hex-char digest", () => {
    const a = hashRefreshToken("hello");
    const b = hashRefreshToken("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateRefreshTokenValue produces a unique base64url string each call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const v = generateRefreshTokenValue();
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(seen.has(v)).toBe(false);
      seen.add(v);
    }
  });
});

describe("InMemoryRefreshTokenStore — issue + findByHash", () => {
  it("returns null on unknown hash", async () => {
    const store = new InMemoryRefreshTokenStore();
    const found = await store.findByHash(hashRefreshToken("missing"));
    expect(found).toBeNull();
  });

  it("issue persists a row that findByHash can return", async () => {
    const store = new InMemoryRefreshTokenStore();
    const data = input();
    const row = await store.issue(data);
    expect(row.accountId).toBe(data.accountId);
    expect(row.tokenHash).toBe(data.tokenHash);
    expect(row.revokedAt).toBeNull();
    expect(row.replacedById).toBeNull();
    expect(row.userAgent).toBe(data.userAgent);
    expect(row.issuedFromIp).toBe(data.issuedFromIp);

    const found = await store.findByHash(data.tokenHash);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(row.id);
  });
});

describe("InMemoryRefreshTokenStore — rotate", () => {
  it("links the old row to the new via replacedById", async () => {
    const store = new InMemoryRefreshTokenStore();
    const a = await store.issue(input({ tokenHash: hashRefreshToken("a") }));
    const b = await store.rotate(a.id, input({ tokenHash: hashRefreshToken("b") }));

    const aAfter = await store.findByHash(hashRefreshToken("a"));
    expect(aAfter!.replacedById).toBe(b.id);
    expect(b.replacedById).toBeNull();
  });

  it("throws when rotating an unknown id", async () => {
    const store = new InMemoryRefreshTokenStore();
    await expect(store.rotate("nope", input())).rejects.toThrow(/unknown id/);
  });
});

describe("InMemoryRefreshTokenStore — revoke", () => {
  it("marks revokedAt; idempotent on second call", async () => {
    const store = new InMemoryRefreshTokenStore();
    const row = await store.issue(input());
    await store.revoke(row.id);
    const after = await store.findByHash(row.tokenHash);
    expect(after!.revokedAt).toBeInstanceOf(Date);
    const before = after!.revokedAt!.getTime();
    await store.revoke(row.id);
    const second = await store.findByHash(row.tokenHash);
    expect(second!.revokedAt!.getTime()).toBe(before);
  });

  it("revoke on unknown id is a no-op", async () => {
    const store = new InMemoryRefreshTokenStore();
    await expect(store.revoke("missing")).resolves.toBeUndefined();
  });
});

describe("InMemoryRefreshTokenStore — revokeChain", () => {
  it("revokes both ancestors and descendants of a presented id", async () => {
    const store = new InMemoryRefreshTokenStore();
    const a = await store.issue(input({ tokenHash: hashRefreshToken("a") }));
    const b = await store.rotate(a.id, input({ tokenHash: hashRefreshToken("b") }));
    const c = await store.rotate(b.id, input({ tokenHash: hashRefreshToken("c") }));

    // Present `b` (the middle of the chain). Both `a` (predecessor) and `c`
    // (successor) should be revoked along with `b`.
    const count = await store.revokeChain(b.id);
    expect(count).toBe(3);

    for (const id of [a.id, b.id, c.id]) {
      const row = await store.findByHash(
        id === a.id
          ? hashRefreshToken("a")
          : id === b.id
            ? hashRefreshToken("b")
            : hashRefreshToken("c"),
      );
      expect(row!.revokedAt).toBeInstanceOf(Date);
    }
  });

  it("returns 0 when the chain is already fully revoked (idempotent)", async () => {
    const store = new InMemoryRefreshTokenStore();
    const a = await store.issue(input({ tokenHash: hashRefreshToken("a") }));
    const b = await store.rotate(a.id, input({ tokenHash: hashRefreshToken("b") }));

    const first = await store.revokeChain(a.id);
    expect(first).toBe(2);
    const second = await store.revokeChain(b.id);
    expect(second).toBe(0);
  });

  it("does not affect rows from other accounts", async () => {
    const store = new InMemoryRefreshTokenStore();
    const a = await store.issue(input({ accountId: "acct-1", tokenHash: hashRefreshToken("a") }));
    const x = await store.issue(input({ accountId: "acct-2", tokenHash: hashRefreshToken("x") }));
    await store.revokeChain(a.id);
    const xAfter = await store.findByHash(hashRefreshToken("x"));
    expect(xAfter!.revokedAt).toBeNull();
    expect(x.id).toBeDefined();
  });
});

describe("InMemoryRefreshTokenStore — revokeAllForAccount", () => {
  it("revokes every active row for the account; returns count", async () => {
    const store = new InMemoryRefreshTokenStore();
    await store.issue(input({ accountId: "alice", tokenHash: hashRefreshToken("a1") }));
    await store.issue(input({ accountId: "alice", tokenHash: hashRefreshToken("a2") }));
    await store.issue(input({ accountId: "bob", tokenHash: hashRefreshToken("b1") }));

    const count = await store.revokeAllForAccount("alice");
    expect(count).toBe(2);

    expect((await store.findByHash(hashRefreshToken("a1")))!.revokedAt).toBeInstanceOf(Date);
    expect((await store.findByHash(hashRefreshToken("a2")))!.revokedAt).toBeInstanceOf(Date);
    expect((await store.findByHash(hashRefreshToken("b1")))!.revokedAt).toBeNull();
  });

  it("skips already-revoked rows in the count", async () => {
    const store = new InMemoryRefreshTokenStore();
    const a = await store.issue(input({ accountId: "alice", tokenHash: hashRefreshToken("a") }));
    await store.revoke(a.id);
    await store.issue(input({ accountId: "alice", tokenHash: hashRefreshToken("a2") }));

    const count = await store.revokeAllForAccount("alice");
    expect(count).toBe(1);
  });
});
