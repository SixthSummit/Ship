import { permission } from "@sixthsummit/ship-core";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthVerifyResult,
} from "../app/auth/AuthProvider.js";
import { defineHonoCredentialAdapter, honoAuthProvider, requestHeadersCredential } from "./auth.js";

interface TestAccount extends AuthenticatedAccount {
  readonly email: string;
}

const claims: AuthClaims = { subject: "subject-1", email: "agent@example.com" };

describe("Hono credential adapters", () => {
  it("extracts an immutable lower-case header credential", async () => {
    const adapter = requestHeadersCredential();
    const credential = await adapter.extract(
      new Request("https://example.test", {
        headers: { Authorization: "Bearer token", "X-Custom": "value" },
      }),
    );

    expect(credential).toMatchObject({ authorization: "Bearer token", "x-custom": "value" });
    expect(Object.isFrozen(credential)).toBe(true);
    expect(Object.isFrozen(adapter)).toBe(true);
  });

  it("preserves a custom credential type and validates untyped declarations", async () => {
    const adapter = defineHonoCredentialAdapter({
      id: "http.bearer",
      extract: (request) => request.headers.get("authorization")?.replace(/^Bearer /u, ""),
    });

    await expect(
      Promise.resolve(
        adapter.extract(
          new Request("https://example.test", { headers: { authorization: "Bearer x" } }),
        ),
      ),
    ).resolves.toBe("x");
    const define = defineHonoCredentialAdapter as (adapter: unknown) => unknown;
    expect(() => define({ id: "Bad Adapter", extract: () => undefined })).toThrow(TypeError);
    expect(() => define({ id: "http.bearer" })).toThrow(TypeError);
  });
});

describe("honoAuthProvider", () => {
  it("verifies, resolves, and snapshots only permissions requested by the operation", async () => {
    const account: TestAccount = {
      id: "actor-1",
      email: "agent@example.com",
      hasPermission: vi.fn(async (name) => name === "fixtures:read"),
    };
    const provider = fakeProvider({ account });
    const auth = honoAuthProvider(provider);
    const credential = await auth.credentials.extract(
      new Request("https://example.test", { headers: { authorization: "Bearer valid" } }),
    );
    const result = await auth.actors.resolve({
      credential,
      operation: {
        id: "fixtures.read",
        access: permission("fixtures:read", "fixtures:write"),
      },
      requestId: "request-1",
    });

    expect(result).toMatchObject({ ok: true, actor: { id: "actor-1" } });
    if (result.ok) {
      expect([...result.actor!.permissions!]).toEqual(["fixtures:read"]);
      expect(Reflect.get(result.actor!.permissions!, "add")).toBeUndefined();
    }
    expect(account.hasPermission).toHaveBeenCalledTimes(2);
    expect(provider.verify).toHaveBeenCalledWith({
      headers: expect.objectContaining({ authorization: "Bearer valid" }),
    });
    expect(provider.resolve).toHaveBeenCalledWith(claims);
  });

  it.each([
    ["missing-token", undefined, { ok: true }],
    ["invalid-token", undefined, { ok: false, reason: "invalid-credential" }],
    ["expired-token", undefined, { ok: false, reason: "invalid-credential" }],
    ["provider-error", undefined, { ok: false, reason: "unavailable" }],
    [null, undefined, { ok: false, reason: "forbidden" }],
    [null, "next", { ok: true }],
  ] as const)("maps provider outcome %# without exposing provider messages", async (failure, unknownPolicy, expected) => {
    const provider = fakeProvider({
      ...(failure ? { verification: { ok: false, reason: failure, message: "sensitive" } } : {}),
      ...(!failure ? { account: null } : {}),
      ...(unknownPolicy ? { onUnknownAccount: unknownPolicy } : {}),
    });
    const auth = honoAuthProvider(provider);

    await expect(
      auth.actors.resolve({
        credential: {},
        operation: { id: "fixtures.read", access: permission("fixtures:read") },
        requestId: "request-1",
      }),
    ).resolves.toEqual(expected);
  });

  it("maps provider exceptions and malformed account ids to unavailable", async () => {
    const throwing = fakeProvider({ verifyError: new Error("provider offline") });
    const malformed = fakeProvider({ account: { id: "", email: "bad@example.com" } });
    const request = {
      credential: {},
      operation: { id: "fixtures.read", access: permission("fixtures:read") },
      requestId: "request-1",
    };

    await expect(honoAuthProvider(throwing).actors.resolve(request)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(honoAuthProvider(malformed).actors.resolve(request)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("normalizes an arbitrary provider name into a stable resolver id", () => {
    expect(honoAuthProvider(fakeProvider({ name: " Firebase Admin " })).actors.id).toBe(
      "v4.firebase-admin",
    );
    expect(honoAuthProvider(fakeProvider({ name: "---" })).actors.id).toBe("v4.provider");
  });
});

function fakeProvider(options: {
  readonly name?: string;
  readonly verification?: AuthVerifyResult;
  readonly account?: TestAccount | null;
  readonly onUnknownAccount?: AuthProvider<TestAccount>["onUnknownAccount"];
  readonly verifyError?: Error;
}): AuthProvider<TestAccount> & {
  verify: ReturnType<typeof vi.fn<AuthProvider<TestAccount>["verify"]>>;
  resolve: ReturnType<typeof vi.fn<AuthProvider<TestAccount>["resolve"]>>;
} {
  const verify = vi.fn<AuthProvider<TestAccount>["verify"]>(async () => {
    if (options.verifyError) throw options.verifyError;
    return options.verification ?? { ok: true, claims };
  });
  const resolve = vi.fn<AuthProvider<TestAccount>["resolve"]>(async () =>
    options.account === undefined ? { id: "actor-1", email: "agent@example.com" } : options.account,
  );
  return {
    name: options.name ?? "fixture",
    verify,
    resolve,
    ...(options.onUnknownAccount ? { onUnknownAccount: options.onUnknownAccount } : {}),
  };
}
