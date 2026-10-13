import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProviderContext } from "../AuthProvider.js";

// Shared mock for firebase-admin. Returned `auth()` exposes a `verifyIdToken`
// spy so each test can program the resolved/rejected outcome.
const verifyIdToken = vi.fn();
vi.mock("firebase-admin", () => ({
  default: {
    auth: () => ({ verifyIdToken }),
    app: { App: class {} },
  },
}));

import { FirebaseAuthProvider, firebaseAuth } from "./firebase.js";

interface TestAccount {
  id: string;
  firebaseUid: string;
  hasPermission?: (slug: string) => boolean;
}

function makeCtx(
  headers: Record<string, string | undefined> = {},
  raw?: string,
): AuthProviderContext {
  return { headers, rawCredential: raw };
}

describe("FirebaseAuthProvider.verify", () => {
  beforeEach(() => {
    verifyIdToken.mockReset();
  });

  it("returns missing-token when no credential is present", async () => {
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    const result = await provider.verify(makeCtx());
    expect(result).toEqual({
      ok: false,
      reason: "missing-token",
      message: expect.any(String),
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("extracts a Bearer token from the Authorization header", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "u-1",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
      iss: "https://securetoken.google.com/test",
      aud: "test",
      iat: 100,
      exp: 200,
      firebase: { sign_in_provider: "google.com" },
    });

    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    const result = await provider.verify(makeCtx({ authorization: "Bearer abc.def.ghi" }));

    expect(verifyIdToken).toHaveBeenCalledWith("abc.def.ghi", false);
    if (!result.ok) throw new Error("expected ok");
    expect(result.claims.subject).toBe("u-1");
    expect(result.claims.email).toBe("alice@example.com");
    expect(result.claims.emailVerified).toBe(true);
    expect(result.claims.name).toBe("Alice");
    expect(result.claims.issuedAt).toBe(100);
    expect(result.claims.expiresAt).toBe(200);
    expect(result.claims.metadata).toMatchObject({
      firebase: {
        audience: "test",
        issuer: expect.stringContaining("securetoken"),
        signInProvider: "google.com",
      },
      customClaims: {},
    });
  });

  it("prefers X-Forwarded-Authorization over Authorization", async () => {
    verifyIdToken.mockResolvedValueOnce({ uid: "u-2", iat: 1, exp: 2 });
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    await provider.verify(
      makeCtx({
        authorization: "Bearer ignored",
        "x-forwarded-authorization": "Bearer forwarded",
      }),
    );
    expect(verifyIdToken).toHaveBeenCalledWith("forwarded", false);
  });

  it("prefers rawCredential when supplied (e.g. cookie-extracted token)", async () => {
    verifyIdToken.mockResolvedValueOnce({ uid: "u-3", iat: 1, exp: 2 });
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    await provider.verify(makeCtx({ authorization: "Bearer header-token" }, "Bearer raw-token"));
    expect(verifyIdToken).toHaveBeenCalledWith("raw-token", false);
  });

  it("propagates checkRevoked option to firebase-admin", async () => {
    verifyIdToken.mockResolvedValueOnce({ uid: "u-4", iat: 1, exp: 2 });
    const provider = firebaseAuth<TestAccount>({
      findAccount: async () => null,
      checkRevoked: true,
    });
    await provider.verify(makeCtx({ authorization: "Bearer t" }));
    expect(verifyIdToken).toHaveBeenCalledWith("t", true);
  });

  it("classifies expired tokens", async () => {
    verifyIdToken.mockRejectedValueOnce({
      code: "auth/id-token-expired",
      message: "Token expired",
    });
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    const result = await provider.verify(makeCtx({ authorization: "Bearer expired" }));
    expect(result).toEqual({ ok: false, reason: "expired-token", message: "Token expired" });
  });

  it("classifies revoked tokens", async () => {
    verifyIdToken.mockRejectedValueOnce({
      code: "auth/id-token-revoked",
      message: "Revoked",
    });
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    const result = await provider.verify(makeCtx({ authorization: "Bearer revoked" }));
    expect(result).toEqual({ ok: false, reason: "revoked-token", message: "Revoked" });
  });

  it("classifies invalid tokens (argument-error)", async () => {
    verifyIdToken.mockRejectedValueOnce({
      code: "auth/argument-error",
      message: "Invalid",
    });
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    const result = await provider.verify(makeCtx({ authorization: "Bearer bad" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid-token");
  });

  it("falls back to provider-error for unknown failure codes", async () => {
    verifyIdToken.mockRejectedValueOnce({ code: "auth/network-error", message: "boom" });
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    const result = await provider.verify(makeCtx({ authorization: "Bearer t" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("provider-error");
  });

  it("extracts custom claims while filtering standard JWT fields", async () => {
    verifyIdToken.mockResolvedValueOnce({
      uid: "u-5",
      email: "x@y.com",
      iss: "i",
      aud: "a",
      iat: 1,
      exp: 2,
      role: "admin",
      tenantId: "tenant-1",
    });
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    const result = await provider.verify(makeCtx({ authorization: "Bearer t" }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.claims.metadata?.customClaims).toEqual({
      role: "admin",
      tenantId: "tenant-1",
    });
  });
});

describe("FirebaseAuthProvider.resolve", () => {
  it("delegates to the supplied findAccount callback with subject + claims", async () => {
    const findAccount = vi.fn().mockResolvedValue({ id: "a-1", firebaseUid: "u-1" } as TestAccount);
    const provider = firebaseAuth<TestAccount>({ findAccount });

    const claims = { subject: "u-1", email: "x@y.com" };
    const account = await provider.resolve(claims);

    expect(findAccount).toHaveBeenCalledWith("u-1", claims);
    expect(account).toEqual({ id: "a-1", firebaseUid: "u-1" });
  });

  it("returns null when the lookup yields nothing", async () => {
    const provider = firebaseAuth<TestAccount>({ findAccount: async () => null });
    expect(await provider.resolve({ subject: "missing" })).toBeNull();
  });
});

describe("FirebaseAuthProvider configuration defaults", () => {
  it("defaults onMissingToken to reject", () => {
    const p = new FirebaseAuthProvider({ findAccount: async () => null });
    expect(p.onMissingToken).toBe("reject");
  });

  it("defaults onUnknownAccount to reject", () => {
    const p = new FirebaseAuthProvider({ findAccount: async () => null });
    expect(p.onUnknownAccount).toBe("reject");
  });

  it("respects override values", () => {
    const p = new FirebaseAuthProvider({
      findAccount: async () => null,
      onMissingToken: "next",
      onUnknownAccount: "next",
    });
    expect(p.onMissingToken).toBe("next");
    expect(p.onUnknownAccount).toBe("next");
  });
});
