import {
  authenticatedAccess,
  defineApp,
  defineModule,
  defineOperation,
  operationActor,
  optionalIdentityAccess,
  publicAccess,
  type RuntimeSchema,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import type { DecodedIdToken } from "firebase-admin/auth";
import { describe, expect, it, vi } from "vitest";
import {
  type FirebaseCredential,
  type FirebaseTokenVerifier,
  firebaseActorResolver,
  firebaseAuthentication,
  firebaseBearerCredentials,
} from "./index.js";

const decoded = { uid: "firebase-user-1", iat: 1, exp: 2 } as DecodedIdToken;

function verifier(result: DecodedIdToken | Error = decoded): FirebaseTokenVerifier {
  return {
    verifyIdToken: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function request(credential: FirebaseCredential | undefined, access = authenticatedAccess()) {
  return {
    credential,
    operation: { id: "accounts.read", access },
    requestId: "request-1",
  };
}

describe("firebaseBearerCredentials", () => {
  it("extracts and freezes a strict authorization bearer token", async () => {
    const adapter = firebaseBearerCredentials();
    const credential = await adapter.extract(
      new Request("https://api.example.test", {
        headers: { authorization: "bEaReR\t abc.def.ghi " },
      }),
    );

    expect(credential).toEqual({
      kind: "firebase.id-token",
      token: "abc.def.ghi",
      source: "authorization",
    });
    expect(Object.isFrozen(credential)).toBe(true);
  });

  it("distinguishes absent, malformed, and oversized credentials", async () => {
    const adapter = firebaseBearerCredentials({ maxTokenLength: 3 });

    expect(await adapter.extract(new Request("https://api.example.test"))).toBeUndefined();
    expect(
      await adapter.extract(
        new Request("https://api.example.test", { headers: { authorization: "Basic secret" } }),
      ),
    ).toMatchObject({ kind: "firebase.invalid-credential", reason: "malformed" });
    expect(
      await adapter.extract(
        new Request("https://api.example.test", { headers: { authorization: "Bearer long" } }),
      ),
    ).toMatchObject({ kind: "firebase.invalid-credential", reason: "too-large" });
  });

  it("trusts forwarded authorization only when explicitly enabled", async () => {
    const forwarded = new Request("https://api.example.test", {
      headers: { "x-forwarded-authorization": "Bearer proxy-token" },
    });

    expect(await firebaseBearerCredentials().extract(forwarded)).toBeUndefined();
    expect(
      await firebaseBearerCredentials({ allowForwardedAuthorization: true }).extract(forwarded),
    ).toMatchObject({ token: "proxy-token", source: "x-forwarded-authorization" });
  });

  it("prefers a direct credential when forwarded authorization is trusted", async () => {
    const credential = await firebaseBearerCredentials({
      allowForwardedAuthorization: true,
    }).extract(
      new Request("https://api.example.test", {
        headers: {
          authorization: "Bearer direct",
          "x-forwarded-authorization": "Bearer forwarded",
        },
      }),
    );

    expect(credential).toMatchObject({ token: "direct", source: "authorization" });
  });

  it("can explicitly prefer a trusted proxy credential", async () => {
    const credential = await firebaseBearerCredentials({
      forwardedAuthorization: "prefer",
    }).extract(
      new Request("https://api.example.test", {
        headers: {
          authorization: "Bearer direct",
          "x-forwarded-authorization": "Bearer forwarded",
        },
      }),
    );

    expect(credential).toMatchObject({
      token: "forwarded",
      source: "x-forwarded-authorization",
    });
  });

  it("rejects invalid token length configuration", () => {
    expect(() => firebaseBearerCredentials({ maxTokenLength: 0 })).toThrow(TypeError);
  });

  it("rejects ambiguous or invalid forwarded-header policies", () => {
    expect(() =>
      firebaseBearerCredentials({
        allowForwardedAuthorization: true,
        forwardedAuthorization: "prefer",
      }),
    ).toThrow(TypeError);
    expect(() => firebaseBearerCredentials({ forwardedAuthorization: "invalid" as never })).toThrow(
      TypeError,
    );
  });
});

describe("firebaseActorResolver", () => {
  it("permits missing credentials for public and optional-identity operations", async () => {
    const resolver = firebaseActorResolver({ verifier: verifier(), resolveActor: () => null });

    await expect(resolver.resolve(request(undefined, publicAccess()))).resolves.toEqual({
      ok: true,
    });
    await expect(resolver.resolve(request(undefined, optionalIdentityAccess()))).resolves.toEqual({
      ok: true,
    });
    await expect(resolver.resolve(request(undefined))).resolves.toEqual({
      ok: false,
      reason: "invalid-credential",
    });
  });

  it("rejects a malformed credential without calling Firebase", async () => {
    const tokenVerifier = verifier();
    const resolver = firebaseActorResolver({ verifier: tokenVerifier, resolveActor: () => null });

    await expect(
      resolver.resolve(
        request({
          kind: "firebase.invalid-credential",
          reason: "malformed",
          source: "authorization",
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid-credential" });
    expect(tokenVerifier.verifyIdToken).not.toHaveBeenCalled();
  });

  it("accepts a kind-less actor built on ship-core 1.0 as a human actor", async () => {
    const resolver = firebaseActorResolver({
      verifier: verifier(),
      resolveActor: () => ({ id: "account-1", permissions: new Set(["accounts:read"]) }),
    });

    const result = await resolver.resolve(
      request({ kind: "firebase.id-token", token: "id-token", source: "authorization" }),
    );

    expect(result).toMatchObject({ ok: true, actor: { id: "account-1", kind: "human" } });
    if (!result.ok || !result.actor) throw new Error("expected actor");
    expect(result.actor.permissions?.has("accounts:read")).toBe(true);
  });

  it("verifies a token and delegates domain actor construction", async () => {
    const tokenVerifier = verifier();
    const resolveActor = vi.fn(() =>
      operationActor({ id: "account-1", permissions: ["accounts:read"] }),
    );
    const resolver = firebaseActorResolver({
      verifier: tokenVerifier,
      checkRevoked: true,
      resolveActor,
    });
    const credential = {
      kind: "firebase.id-token",
      token: "id-token",
      source: "authorization",
    } as const;

    const result = await resolver.resolve(request(credential));

    expect(tokenVerifier.verifyIdToken).toHaveBeenCalledWith("id-token", true);
    expect(resolveActor).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "firebase-user-1",
        token: decoded,
        operation: { id: "accounts.read", access: authenticatedAccess() },
        requestId: "request-1",
      }),
    );
    expect(result).toMatchObject({ ok: true, actor: { id: "account-1" } });
    expect(result).toMatchObject({
      identity: { provider: "firebase", subject: "firebase-user-1" },
    });
    if (!result.ok || !result.actor) throw new Error("expected actor");
    expect(result.actor.permissions?.has("accounts:read")).toBe(true);
    expect(() => (result.actor!.permissions as Set<string>).add("accounts:write")).toThrow();
  });

  it.each([
    "auth/argument-error",
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/invalid-id-token",
    "auth/tenant-id-mismatch",
    "auth/user-disabled",
  ])("classifies %s as an invalid credential", async (code) => {
    const error = Object.assign(new Error("rejected"), { code });
    const resolver = firebaseActorResolver({ verifier: verifier(error), resolveActor: () => null });
    const credential = {
      kind: "firebase.id-token",
      token: "bad",
      source: "authorization",
    } as const;

    await expect(resolver.resolve(request(credential))).resolves.toEqual({
      ok: false,
      reason: "invalid-credential",
    });
  });

  it("maps provider and actor-store failures to unavailable", async () => {
    const credential = {
      kind: "firebase.id-token",
      token: "token",
      source: "authorization",
    } as const;
    const providerFailure = firebaseActorResolver({
      verifier: verifier(Object.assign(new Error("network"), { code: "auth/network-error" })),
      resolveActor: () => null,
    });
    const lookupFailure = firebaseActorResolver({
      verifier: verifier(),
      resolveActor: () => {
        throw new Error("database unavailable");
      },
    });

    await expect(providerFailure.resolve(request(credential))).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(lookupFailure.resolve(request(credential))).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("returns forbidden when a verified user has no application actor", async () => {
    const resolver = firebaseActorResolver({ verifier: verifier(), resolveActor: () => null });

    await expect(
      resolver.resolve(
        request({ kind: "firebase.id-token", token: "token", source: "authorization" }),
      ),
    ).resolves.toEqual({ ok: false, reason: "forbidden" });
  });

  it("preserves a verified identity when an optional route has no application actor", async () => {
    const resolver = firebaseActorResolver({ verifier: verifier(), resolveActor: () => null });

    await expect(
      resolver.resolve(
        request(
          { kind: "firebase.id-token", token: "token", source: "authorization" },
          optionalIdentityAccess(),
        ),
      ),
    ).resolves.toEqual({
      ok: true,
      identity: { provider: "firebase", subject: "firebase-user-1" },
    });
  });

  it("rejects invalid application actor output", async () => {
    const resolver = firebaseActorResolver({
      verifier: verifier(),
      resolveActor: () => ({ id: "" }),
    });

    await expect(
      resolver.resolve(
        request({ kind: "firebase.id-token", token: "token", source: "authorization" }),
      ),
    ).rejects.toThrow("operation actor or null");
  });

  it("validates composition options", () => {
    expect(() => firebaseActorResolver({ resolveActor: undefined } as never)).toThrow(TypeError);
    expect(() =>
      firebaseActorResolver({
        resolveActor: () => null,
        verifier: verifier(),
        firebaseApp: {} as never,
      }),
    ).toThrow("verifier or firebaseApp");
  });
});

describe("firebaseAuthentication", () => {
  it("returns the frozen Hono authentication pair", () => {
    const auth = firebaseAuthentication({ verifier: verifier(), resolveActor: () => null });

    expect(auth.credentials.id).toBe("firebase.bearer");
    expect(auth.actors.id).toBe("firebase.actors");
    expect(Object.isFrozen(auth)).toBe(true);
  });

  it.each([
    {
      name: "missing credential",
      expectedStatus: 401,
    },
    {
      name: "invalid token",
      authorization: "Bearer invalid",
      verificationError: Object.assign(new Error("secret provider detail"), {
        code: "auth/invalid-id-token",
      }),
      expectedStatus: 401,
    },
    {
      name: "unknown application actor",
      authorization: "Bearer valid",
      actor: null,
      expectedStatus: 403,
    },
    {
      name: "provider outage",
      authorization: "Bearer unavailable",
      verificationError: Object.assign(new Error("secret outage detail"), {
        code: "auth/network-error",
      }),
      expectedStatus: 503,
    },
    {
      name: "valid actor",
      authorization: "Bearer valid",
      actor: operationActor({ id: "account-1" }),
      expectedStatus: 200,
    },
  ])("projects $name through the Hono wire contract", async (fixture) => {
    const auth = firebaseAuthentication({
      verifier: verifier(fixture.verificationError ?? decoded),
      resolveActor: () => fixture.actor ?? null,
    });
    const app = createHonoAdapter(authenticationFixture(), { auth });
    const response = await app.request("/private", {
      headers: fixture.authorization ? { authorization: fixture.authorization } : {},
    });

    expect(response.status).toBe(fixture.expectedStatus);
    const body = await response.json();
    if (fixture.expectedStatus === 200) {
      expect(body).toEqual({ actorId: "account-1" });
    } else {
      expect(JSON.stringify(body)).not.toContain("secret");
    }
  });
});

function authenticationFixture() {
  const output = schema<{ readonly actorId: string }>((value) => {
    if (typeof value !== "object" || value === null) return undefined;
    const actorId = Reflect.get(value, "actorId");
    return typeof actorId === "string" ? { actorId } : undefined;
  });
  const operation = defineOperation({
    id: "accounts.private",
    transport: http.get("/private"),
    input: {},
    output: { 200: output },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: {},
    handler: ({ context }) => ({ actorId: context.actor!.id }),
  });
  return defineApp({
    id: "firebase-auth-test",
    modules: [
      defineModule({
        id: "accounts",
        operations: [operation],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
}

function schema<TOutput>(
  parse: (value: unknown) => TOutput | undefined,
): RuntimeSchema<unknown, TOutput> {
  return {
    "~standard": {
      version: 1,
      vendor: "firebase-test",
      validate: (value) => {
        const output = parse(value);
        return output === undefined ? { issues: [{ message: "invalid" }] } : { value: output };
      },
    },
  };
}
