import type { CredentialStore } from "./store.js";

export interface ConformanceTestApi {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void> | void) => void;
  readonly beforeEach: (body: () => Promise<void> | void) => void;
  readonly expect: (value: unknown) => any;
}

export interface CredentialStoreConformanceHarness {
  /** A fresh, empty store for every test. */
  readonly create: () => Promise<CredentialStore> | CredentialStore;
}

/**
 * Proves a `CredentialStore` implements the once-only semantics the flows
 * rely on: a token, a recovery code and a TOTP step are consumed exactly once,
 * revocations report whether they won, lookups normalise emails and audit
 * rows list newest first. Run it against every store you ship.
 */
export function credentialStoreConformance(
  name: string,
  harness: CredentialStoreConformanceHarness,
  api: ConformanceTestApi,
): void {
  const { describe, it, beforeEach, expect } = api;
  const t0 = new Date("2026-10-23T10:00:00.000Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  let store: CredentialStore;

  describe(`${name} credential store conformance`, () => {
    beforeEach(async () => {
      store = await harness.create();
    });

    const account = async (email = "Ada@Example.test") => {
      const created = await store.createAccount({
        email,
        name: "Ada",
        roles: ["member"],
        passwordHash: "$scrypt$x",
        algorithm: "scrypt",
        now: t0,
      });
      if (!created.ok) throw new Error("account should be created");
      return created.account;
    };

    it("creates accounts with a normalised unique email and a credential", async () => {
      const created = await account();
      expect(created.email).toBe("ada@example.test");
      expect(created.roles).toEqual(["member"]);
      expect(created.failedAttempts).toBe(0);
      expect(await store.findAccount(created.id)).toEqual(created);
      expect(await store.findAccountByEmail("  ADA@example.test")).toEqual(created);
      expect(await store.findAccount("not-an-id")).toBeUndefined();
      const credential = await store.findCredential(created.id);
      expect(credential).toMatchObject({
        accountId: created.id,
        passwordHash: "$scrypt$x",
        algorithm: "scrypt",
      });
      const duplicate = await store.createAccount({
        email: "ada@EXAMPLE.test",
        roles: [],
        passwordHash: "y",
        algorithm: "scrypt",
        now: t0,
      });
      expect(duplicate).toEqual({ ok: false, reason: "email-taken" });
      await store.setCredential(created.id, {
        passwordHash: "z",
        algorithm: "argon2id",
        now: at(1),
      });
      expect(await store.findCredential(created.id)).toMatchObject({
        passwordHash: "z",
        algorithm: "argon2id",
      });
    });

    it("patches accounts and refuses a taken email", async () => {
      const ada = await account();
      const bob = await account("bob@example.test");
      const updated = await store.updateAccount(
        ada.id,
        {
          status: "disabled",
          failedAttempts: 3,
          lockedUntil: at(1_000),
          roles: ["admin"],
          emailVerifiedAt: t0,
        },
        at(5),
      );
      expect(updated).toMatchObject({
        ok: true,
        account: {
          status: "disabled",
          failedAttempts: 3,
          lockedUntil: at(1_000),
          roles: ["admin"],
          emailVerifiedAt: t0,
          updatedAt: at(5),
        },
      });
      const cleared = await store.updateAccount(
        ada.id,
        { lockedUntil: null, failedAttempts: 0, lastFailedAt: null },
        at(6),
      );
      expect(cleared.ok && cleared.account.lockedUntil).toBeUndefined();
      expect(await store.updateAccount(ada.id, { email: bob.email }, at(7))).toEqual({
        ok: false,
        reason: "email-taken",
      });
      expect(await store.updateAccount("missing", { name: "x" }, at(8))).toEqual({
        ok: false,
        reason: "not-found",
      });
      const renamed = await store.updateAccount(
        ada.id,
        { email: "Ada2@Example.test", name: null },
        at(9),
      );
      expect(renamed).toMatchObject({ ok: true, account: { email: "ada2@example.test" } });
      expect(renamed.ok && renamed.account.name).toBeUndefined();
    });

    it("consumes a token exactly once, respects expiry and supersedes by purpose", async () => {
      const ada = await account();
      const token = await store.createToken({
        accountId: ada.id,
        purpose: "verify-email",
        tokenHash: "hash-1",
        payload: { email: "x@y.z" },
        expiresAt: at(60_000),
        now: t0,
      });
      expect(token).toMatchObject({
        accountId: ada.id,
        purpose: "verify-email",
        payload: { email: "x@y.z" },
      });
      expect(
        await store.findToken({ tokenHash: "hash-1", purpose: "reset-password", now: at(1) }),
      ).toBeUndefined();
      expect(
        await store.findToken({ tokenHash: "hash-1", purpose: "verify-email", now: at(1) }),
      ).toMatchObject({ id: token.id });
      expect(
        await store.findToken({ tokenHash: "hash-1", purpose: "verify-email", now: at(60_000) }),
      ).toBeUndefined();
      const consumed = await store.consumeToken({
        tokenHash: "hash-1",
        purpose: "verify-email",
        now: at(2),
      });
      expect(consumed).toMatchObject({ id: token.id, consumedAt: at(2) });
      expect(
        await store.consumeToken({ tokenHash: "hash-1", purpose: "verify-email", now: at(3) }),
      ).toBeUndefined();
      await store.createToken({
        accountId: ada.id,
        purpose: "reset-password",
        tokenHash: "r1",
        expiresAt: at(60_000),
        now: t0,
      });
      await store.createToken({
        accountId: ada.id,
        purpose: "reset-password",
        tokenHash: "r2",
        expiresAt: at(60_000),
        now: t0,
      });
      expect(
        await store.revokeTokens({ accountId: ada.id, purpose: "reset-password", now: at(4) }),
      ).toBe(2);
      expect(
        await store.consumeToken({ tokenHash: "r2", purpose: "reset-password", now: at(5) }),
      ).toBeUndefined();
    });

    it("keeps one MFA secret per account and claims steps monotonically", async () => {
      const ada = await account();
      expect(await store.findMfaSecret(ada.id)).toBeUndefined();
      const pending = await store.upsertMfaSecret({
        accountId: ada.id,
        secretCiphertext: "c1",
        keyId: "k1",
        enabledAt: null,
        now: t0,
      });
      expect(pending.enabledAt).toBeUndefined();
      expect(await store.claimMfaStep(ada.id, 100, at(1))).toBe(true);
      expect(await store.claimMfaStep(ada.id, 100, at(2))).toBe(false);
      expect(await store.claimMfaStep(ada.id, 99, at(3))).toBe(false);
      expect(await store.claimMfaStep(ada.id, 101, at(4))).toBe(true);
      const enabled = await store.upsertMfaSecret({
        accountId: ada.id,
        secretCiphertext: "c1",
        keyId: "k1",
        enabledAt: at(5),
        now: at(5),
      });
      expect(enabled).toMatchObject({ enabledAt: at(5), createdAt: t0, updatedAt: at(5) });
      expect((await store.findMfaSecret(ada.id))?.lastUsedStep).toBe(101);
      await store.deleteMfaSecret(ada.id);
      expect(await store.findMfaSecret(ada.id)).toBeUndefined();
      expect(await store.claimMfaStep(ada.id, 200, at(6))).toBe(false);
    });

    it("replaces recovery codes and consumes each once", async () => {
      const ada = await account();
      await store.replaceRecoveryCodes(ada.id, ["a", "b", "c"], t0);
      expect(await store.countRecoveryCodes(ada.id)).toEqual({ remaining: 3, used: 0 });
      expect(
        await store.consumeRecoveryCode({ accountId: ada.id, codeHash: "b", now: at(1) }),
      ).toBe(true);
      expect(
        await store.consumeRecoveryCode({ accountId: ada.id, codeHash: "b", now: at(2) }),
      ).toBe(false);
      expect(
        await store.consumeRecoveryCode({ accountId: ada.id, codeHash: "zz", now: at(2) }),
      ).toBe(false);
      expect(await store.countRecoveryCodes(ada.id)).toEqual({ remaining: 2, used: 1 });
      await store.replaceRecoveryCodes(ada.id, ["d"], at(3));
      expect(await store.countRecoveryCodes(ada.id)).toEqual({ remaining: 1, used: 0 });
      expect(
        await store.consumeRecoveryCode({ accountId: ada.id, codeHash: "a", now: at(4) }),
      ).toBe(false);
    });

    it("tracks sessions by token hash and revokes once, singly or all but one", async () => {
      const ada = await account();
      const first = await store.createSession({
        accountId: ada.id,
        tokenHash: "s1",
        mfaState: "none",
        expiresAt: at(3_600_000),
        ip: "10.0.0.1",
        userAgent: "ua",
        now: t0,
      });
      const second = await store.createSession({
        accountId: ada.id,
        tokenHash: "s2",
        mfaState: "pending-enrolment",
        expiresAt: at(3_600_000),
        now: at(1_000),
      });
      expect(first).toMatchObject({
        mfaState: "none",
        ip: "10.0.0.1",
        userAgent: "ua",
        lastSeenAt: t0,
      });
      expect(await store.findSessionByTokenHash("s2")).toEqual(second);
      expect(await store.findSession(first.id)).toEqual(first);
      expect((await store.listSessions(ada.id)).map((session) => session.id)).toEqual([
        second.id,
        first.id,
      ]);
      await store.touchSession(first.id, at(2_000));
      expect((await store.findSession(first.id))?.lastSeenAt).toEqual(at(2_000));
      expect(await store.updateSession(second.id, { mfaState: "verified" })).toMatchObject({
        mfaState: "verified",
      });
      expect(await store.revokeSession(second.id, { now: at(3_000), reason: "test" })).toBe(true);
      expect(await store.revokeSession(second.id, { now: at(4_000), reason: "test" })).toBe(false);
      expect(await store.findSessionByTokenHash("s2")).toMatchObject({
        revokedAt: at(3_000),
        revokedReason: "test",
      });
      expect((await store.listSessions(ada.id)).map((session) => session.id)).toEqual([first.id]);
      expect(await store.listSessions(ada.id, { includeRevoked: true })).toHaveLength(2);
      const third = await store.createSession({
        accountId: ada.id,
        tokenHash: "s3",
        mfaState: "none",
        expiresAt: at(3_600_000),
        now: at(5_000),
      });
      expect(
        await store.revokeSessions(ada.id, { now: at(6_000), reason: "all", except: third.id }),
      ).toBe(1);
      expect(await store.revokeSessions(ada.id, { now: at(7_000), reason: "all" })).toBe(1);
      expect(await store.listSessions(ada.id)).toEqual([]);
    });

    it("records audit rows newest first with filters", async () => {
      const ada = await account();
      const base = { requestId: "req", outcome: "success" as const };
      await store.recordAudit({
        ...base,
        event: "sign-in",
        accountId: ada.id,
        ip: "1.1.1.1",
        createdAt: t0,
      });
      await store.recordAudit({
        ...base,
        event: "sign-in",
        outcome: "failure",
        accountId: ada.id,
        details: { reason: "wrong-password", attempts: 1 },
        createdAt: at(1),
      });
      await store.recordAudit({ ...base, event: "register", createdAt: at(2) });
      const all = await store.listAudit({ limit: 10 });
      expect(all.map((event) => event.event)).toEqual(["register", "sign-in", "sign-in"]);
      expect(all[1]).toMatchObject({
        outcome: "failure",
        details: { reason: "wrong-password", attempts: 1 },
      });
      expect((await store.listAudit({ accountId: ada.id, limit: 10 })).length).toBe(2);
      expect(
        (await store.listAudit({ event: "sign-in", outcome: "failure", limit: 10 })).length,
      ).toBe(1);
      expect((await store.listAudit({ before: at(1), limit: 10 })).length).toBe(1);
      expect((await store.listAudit({ limit: 2 })).length).toBe(2);
      expect(await store.listAudit({ accountId: "nobody", limit: 5 })).toEqual([]);
    });

    it("cleans up dead tokens and sessions older than the cutoff", async () => {
      const ada = await account();
      await store.createToken({
        accountId: ada.id,
        purpose: "verify-email",
        tokenHash: "old",
        expiresAt: at(1_000),
        now: t0,
      });
      await store.createToken({
        accountId: ada.id,
        purpose: "verify-email",
        tokenHash: "live",
        expiresAt: at(3_600_000),
        now: t0,
      });
      const dead = await store.createSession({
        accountId: ada.id,
        tokenHash: "dead",
        mfaState: "none",
        expiresAt: at(3_600_000),
        now: t0,
      });
      await store.revokeSession(dead.id, { now: at(1_000), reason: "x" });
      await store.createSession({
        accountId: ada.id,
        tokenHash: "alive",
        mfaState: "none",
        expiresAt: at(3_600_000),
        now: t0,
      });
      expect(await store.cleanup({ before: at(60_000) })).toEqual({ tokens: 1, sessions: 1 });
      expect(
        await store.findToken({ tokenHash: "live", purpose: "verify-email", now: at(2) }),
      ).toBeDefined();
      expect(await store.listSessions(ada.id)).toHaveLength(1);
    });
  });
}
