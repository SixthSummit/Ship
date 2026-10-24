import {
  defineApp,
  defineModule,
  defineOperation,
  dependency,
  publicAccess,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createCookieJar,
  createFixture,
  EMAIL,
  fixtureMailer,
  KEY_RING,
  PASSWORD,
  registerAndSignIn,
} from "./__fixtures__/app.js";
import {
  clearSessionCookie,
  credentialSessionCsrfPolicy,
  readCookie,
  resolveSessionPolicy,
  serializeCsrfCookie,
  serializeSessionCookie,
} from "./cookie.js";
import { totpCode, totpStep } from "./crypto/totp.js";
import { createInMemoryCredentialStore } from "./memory-store.js";
import type { CredentialAuthModuleOptions } from "./module.js";
import { defineCredentialAuthModule } from "./module.js";
import { credentialAuthentication } from "./provider.js";

const TOKEN = `ship_s_${"a".repeat(43)}`;
const APP_ORIGIN = "https://app.example.test";

describe("session cookie policy", () => {
  it("defaults to bearer, and to a Secure, HttpOnly, SameSite=Lax cookie at the root path", () => {
    expect(resolveSessionPolicy(undefined)).toMatchObject({
      transports: ["bearer"],
      defaultTransport: "bearer",
      environment: "production",
    });
    const cookie = resolveSessionPolicy({ transport: "cookie" });
    expect(cookie).toMatchObject({ transports: ["cookie"], defaultTransport: "cookie" });
    expect(cookie.cookie).toEqual({
      name: "ship_session",
      path: "/",
      sameSite: "lax",
      secure: true,
      csrf: { cookieName: "ship_csrf", header: "x-csrf-token" },
    });
    const both = resolveSessionPolicy({
      transport: "both",
      cookie: {
        name: "__Host-app_session",
        sameSite: "strict",
        csrf: { cookieName: "__Host-app_csrf", header: "X-App-CSRF" },
      },
    });
    expect(both).toMatchObject({ transports: ["bearer", "cookie"], defaultTransport: "bearer" });
    expect(both.cookie?.csrf.header).toBe("x-app-csrf");
    expect(serializeSessionCookie(both.cookie as never, TOKEN, 3600)).toBe(
      `__Host-app_session=${TOKEN}; Path=/; Max-Age=3600; Secure; SameSite=Strict; HttpOnly`,
    );
  });

  it("refuses an insecure cookie outside development and honours the explicit development opt-out", () => {
    expect(() => resolveSessionPolicy({ transport: "cookie", cookie: { secure: false } })).toThrow(
      /secure: false is only allowed with sessions.environment "development"/u,
    );
    const development = resolveSessionPolicy({
      transport: "cookie",
      environment: "development",
      cookie: { secure: false, domain: "localhost" },
    });
    expect(development.cookie).toMatchObject({ secure: false, domain: "localhost" });
    expect(serializeSessionCookie(development.cookie as never, TOKEN, 60)).toBe(
      `ship_session=${TOKEN}; Path=/; Domain=localhost; Max-Age=60; SameSite=Lax; HttpOnly`,
    );
    expect(clearSessionCookie(development.cookie as never)).toBe(
      "ship_session=; Path=/; Domain=localhost; Max-Age=0; SameSite=Lax; HttpOnly",
    );
    expect(serializeCsrfCookie(development.cookie as never, "csrf-token", 60)).toBe(
      "ship_csrf=csrf-token; Path=/; Domain=localhost; Max-Age=60; SameSite=Lax",
    );
  });

  it("validates names, prefixes, path, domain and sameSite at definition time", () => {
    const cookie = (options: Record<string, unknown>) =>
      resolveSessionPolicy({ transport: "cookie", ...options });
    expect(() => cookie({ cookie: { name: "bad name" } })).toThrow(/cookie name/u);
    expect(() => cookie({ cookie: { csrf: { cookieName: "ship_session" } } })).toThrow(/differ/u);
    expect(() => cookie({ cookie: { path: "api" } })).toThrow(/absolute path/u);
    expect(() => cookie({ cookie: { path: "/;x" } })).toThrow(/absolute path/u);
    expect(() => cookie({ cookie: { domain: "exa mple" } })).toThrow(/host name/u);
    expect(() => cookie({ cookie: { sameSite: "none" } })).toThrow(/sameSite/u);
    expect(() => cookie({ cookie: { name: "__Host-s", domain: "example.test" } })).toThrow(
      /__Host-/u,
    );
    expect(() =>
      cookie({ environment: "development", cookie: { name: "__Secure-s", secure: false } }),
    ).toThrow(/__Secure-/u);
    expect(() => resolveSessionPolicy({ transport: "bearer", cookie: {} })).toThrow(
      /only meaningful/u,
    );
    expect(() => resolveSessionPolicy({ transport: "cookies" as never })).toThrow(/transport/u);
    expect(() => serializeSessionCookie(cookie({}).cookie as never, "x;y", 1)).toThrow(/token/u);
  });

  it("reads one cookie out of a Cookie header", () => {
    expect(readCookie("a=1; ship_session=tok; b=2", "ship_session")).toBe("tok");
    expect(readCookie("ship_session=; b=2", "ship_session")).toBeUndefined();
    expect(readCookie("ship_session_x=1", "ship_session")).toBeUndefined();
    expect(readCookie(null, "ship_session")).toBeUndefined();
  });

  it("requires the clients registry in cookie mode", () => {
    expect(() => createFixture({ sessions: { transport: "cookie" }, clients: null })).toThrow(
      /requires clients/u,
    );
    const store = createInMemoryCredentialStore();
    const mail = dependency("mail.deliver") as CredentialAuthModuleOptions["mail"];
    expect(() =>
      defineCredentialAuthModule({
        store,
        mailer: fixtureMailer,
        mail,
        links: {
          verifyEmail: (token) => `https://x.test/v/${token}`,
          resetPassword: (token) => `https://x.test/r/${token}`,
          changeEmail: (token) => `https://x.test/e/${token}`,
          signIn: "https://x.test/sign-in",
        },
        secrets: KEY_RING,
        sessions: { transport: "both", cookie: { secure: false } },
      }),
    ).toThrow(/secure: false/u);
  });
});

describe("the CSRF pre-validation policy", () => {
  const auth = {
    id: "auth",
    sessions: resolveSessionPolicy({ transport: "both" }),
    policies: { session: { maxAgeMs: 60_000 } },
  };
  const operation = (id: string, method: "get" | "post", path: string) =>
    defineOperation({
      id,
      transport: http[method](path),
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
  const app = defineApp({
    id: "csrf-fixture",
    modules: [
      defineModule({
        id: "auth",
        operations: [operation("auth.sign-in", "post", "/auth/sign-in")],
        providers: [],
        imports: [],
        exports: [],
      }),
      defineModule({
        id: "app",
        operations: [
          operation("app.read", "get", "/app/read"),
          operation("app.write", "post", "/app/write"),
        ],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
  const adapter = createHonoAdapter(app, {
    preValidationPolicies: {
      "*": credentialSessionCsrfPolicy({
        auth,
        trustedOrigins: [APP_ORIGIN],
        generateToken: () => "fresh-csrf",
      }),
    },
  });
  const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    adapter.request(`https://api.example.test${path}`, {
      method: init.method ?? "POST",
      headers: init.headers ?? {},
    });
  const session = `ship_session=${TOKEN}; ship_csrf=csrf-1`;

  it("refuses the whole matrix for a cookie session and accepts a correct echo", async () => {
    const cases: readonly [string, Record<string, string>, number, string | undefined][] = [
      ["missing header", { cookie: session, origin: APP_ORIGIN }, 403, "CSRF token"],
      [
        "mismatched token",
        { cookie: session, origin: APP_ORIGIN, "x-csrf-token": "csrf-2" },
        403,
        "CSRF token",
      ],
      [
        "missing csrf cookie",
        { cookie: `ship_session=${TOKEN}`, origin: APP_ORIGIN, "x-csrf-token": "csrf-1" },
        403,
        "CSRF token",
      ],
      [
        "bad origin",
        { cookie: session, origin: "https://evil.example", "x-csrf-token": "csrf-1" },
        403,
        "origin",
      ],
      ["null origin", { cookie: session, origin: "null", "x-csrf-token": "csrf-1" }, 403, "origin"],
      ["missing origin and referer", { cookie: session, "x-csrf-token": "csrf-1" }, 403, "origin"],
      [
        "bad referer",
        { cookie: session, referer: "https://evil.example/page", "x-csrf-token": "csrf-1" },
        403,
        "origin",
      ],
      [
        "trusted origin",
        { cookie: session, origin: APP_ORIGIN, "x-csrf-token": "csrf-1" },
        200,
        undefined,
      ],
      [
        "trusted referer",
        { cookie: session, referer: `${APP_ORIGIN}/page?x=1`, "x-csrf-token": "csrf-1" },
        200,
        undefined,
      ],
      [
        "own origin",
        { cookie: session, origin: "https://api.example.test", "x-csrf-token": "csrf-1" },
        200,
        undefined,
      ],
      [
        "own forwarded origin",
        {
          cookie: session,
          origin: "https://edge.example.test",
          "x-forwarded-host": "edge.example.test",
          "x-forwarded-proto": "https",
          "x-csrf-token": "csrf-1",
        },
        200,
        undefined,
      ],
      [
        "header case",
        { cookie: session, origin: APP_ORIGIN, "X-CSRF-Token": "csrf-1" },
        200,
        undefined,
      ],
    ];
    for (const [label, headers, status, message] of cases) {
      const response = await call("/app/write", { headers });
      expect(response.status, label).toBe(status);
      if (message) {
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code, label).toBe("AUTHORIZATION_ERROR");
        expect(body.error.message, label).toContain(message);
      }
    }
  });

  it("exempts safe methods, bearer requests and requests without a session cookie", async () => {
    expect((await call("/app/read", { method: "GET", headers: { cookie: session } })).status).toBe(
      200,
    );
    expect(
      (await call("/app/write", { headers: { authorization: `Bearer ${TOKEN}`, cookie: session } }))
        .status,
    ).toBe(200);
    expect((await call("/app/write", { headers: { origin: "https://evil.example" } })).status).toBe(
      200,
    );
    expect((await call("/app/write")).status).toBe(200);
  });

  it("origin-checks session-issuing operations against login CSRF and lets native clients through", async () => {
    const refused = await call("/auth/sign-in", { headers: { origin: "https://evil.example" } });
    expect(refused.status).toBe(403);
    const refusal = (await refused.json()) as { error: { message: string } };
    expect(refusal.error.message).toContain("sign in");
    expect(
      (await call("/auth/sign-in", { headers: { referer: "https://evil.example/" } })).status,
    ).toBe(403);
    expect((await call("/auth/sign-in", { headers: { origin: APP_ORIGIN } })).status).toBe(200);
    expect((await call("/auth/sign-in")).status).toBe(200);
  });

  it("installs the CSRF cookie when a session cookie has none and on every sign-in", async () => {
    const repaired = await call("/app/read", {
      method: "GET",
      headers: { cookie: `ship_session=${TOKEN}` },
    });
    expect(repaired.headers.getSetCookie()).toEqual([
      "ship_csrf=fresh-csrf; Path=/; Max-Age=60; Secure; SameSite=Lax",
    ]);
    const signIn = await call("/auth/sign-in", { headers: { origin: APP_ORIGIN } });
    expect(signIn.headers.getSetCookie()).toHaveLength(1);
    const untouched = await call("/app/read", { method: "GET", headers: { cookie: session } });
    expect(untouched.headers.getSetCookie()).toEqual([]);
    expect((await call("/app/read", { method: "GET" })).headers.getSetCookie()).toEqual([]);
  });

  it("is required at adapter construction whenever the credential adapter reads the cookie", () => {
    const fixture = createFixture({ sessions: { transport: "both" } });
    const auth = credentialAuthentication({
      store: fixture.store,
      session: fixture.auth.policies.session,
      sessions: fixture.auth.sessions,
    });
    expect(auth.credentials.requires).toEqual([
      { key: "*", policyId: "ship-credentials.csrf", message: expect.stringContaining("CSRF") },
    ]);
    const missing = expect.objectContaining({
      code: "SHIP_HONO_OPTIONS_INVALID",
      message: expect.stringContaining("credentialSessionCsrfPolicy"),
    });
    expect(() => createHonoAdapter(fixture.app, { auth })).toThrow(missing);
    expect(() =>
      createHonoAdapter(fixture.app, {
        auth,
        preValidationPolicies: {
          "auth.sign-in": credentialSessionCsrfPolicy({ auth: fixture.auth }),
        },
      }),
    ).toThrow(missing);
    expect(() =>
      createHonoAdapter(fixture.app, {
        auth,
        preValidationPolicies: { "*": () => ({ allowed: true }) },
      }),
    ).toThrow(missing);
    expect(() =>
      createHonoAdapter(fixture.app, {
        auth,
        preValidationPolicies: { "*": credentialSessionCsrfPolicy({ auth: fixture.auth }) },
      }),
    ).not.toThrow();
    expect(() =>
      createHonoAdapter(fixture.app, {
        auth,
        preValidationPolicies: {
          "*": [() => ({ allowed: true }), credentialSessionCsrfPolicy({ auth: fixture.auth })],
        },
      }),
    ).not.toThrow();
    // A bearer-only adapter requires nothing.
    const bearer = createFixture();
    expect(
      credentialAuthentication({ store: bearer.store, sessions: bearer.auth.sessions }).credentials
        .requires,
    ).toBeUndefined();
  });

  it("validates its options", () => {
    expect(() =>
      credentialSessionCsrfPolicy({ auth: { ...auth, sessions: resolveSessionPolicy(undefined) } }),
    ).toThrow(/includes "cookie"/u);
    expect(() => credentialSessionCsrfPolicy({ auth, trustedOrigins: ["ftp://x"] })).toThrow(
      /http\(s\) origin/u,
    );
  });
});

describe("cookie-mode sessions over HTTP", () => {
  const browser = (fixture: ReturnType<typeof createFixture>, trusted = APP_ORIGIN) => {
    const jar = createCookieJar();
    const request = async (
      path: string,
      init: {
        readonly method?: string;
        readonly body?: unknown;
        readonly headers?: Record<string, string>;
        readonly csrf?: boolean;
        readonly origin?: string | null;
      } = {},
    ) => {
      const cookie = jar.header();
      const csrf = jar.get("ship_csrf")?.value;
      const origin = init.origin === undefined ? trusted : init.origin;
      const response = await fixture.request(path, {
        ...(init.method ? { method: init.method } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
          ...(init.csrf !== false && csrf ? { "x-csrf-token": csrf } : {}),
          ...init.headers,
        },
      });
      jar.absorb(response.headers);
      return response;
    };
    return { jar, request };
  };

  it("signs in over the cookie, survives a reload, refuses CSRF-less writes and clears on sign-out", async () => {
    const fixture = createFixture({
      sessions: { transport: "both" },
      trustedOrigins: [APP_ORIGIN],
    });
    await fixture.start();
    await registerAndSignIn(fixture);
    const client = browser(fixture);

    const signedIn = await client.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "cookie" },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.session).toEqual({
      transport: "cookie",
      id: expect.any(String),
      expiresAt: expect.any(String),
      mfaState: "none",
    });
    expect(JSON.stringify(signedIn.body)).not.toContain("ship_s_");
    const sessionCookie = client.jar.get("ship_session");
    expect(sessionCookie?.value).toMatch(/^ship_s_[A-Za-z0-9_-]{43}$/u);
    expect(sessionCookie?.attributes).toBe(
      `Path=/; Max-Age=${30 * 24 * 60 * 60}; Secure; SameSite=Lax; HttpOnly`,
    );
    expect(client.jar.get("ship_csrf")?.attributes).toBe(
      `Path=/; Max-Age=${30 * 24 * 60 * 60}; Secure; SameSite=Lax`,
    );
    expect(fixture.store.auditEvents().at(-1)).toMatchObject({
      event: "sign-in",
      details: { transport: "cookie" },
    });

    // A reload: nothing in script-readable storage, the cookie alone restores the session.
    const me = await client.request("/auth/me", { origin: null });
    expect(me.status).toBe(200);
    expect(me.body.session).toMatchObject({ id: signedIn.body.session.id, current: true });

    // State-changing calls need the echoed CSRF token; safe ones do not.
    const noCsrf = await client.request("/app/slow", { body: {}, csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("AUTHORIZATION_ERROR");
    const crossSite = await client.request("/auth/sessions/revoke-all", {
      body: {},
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    expect((await client.request("/auth/sessions", { origin: null })).status).toBe(200);
    const listed = await client.request("/auth/sessions", { origin: null });
    expect(
      listed.body.sessions.filter((session: { current: boolean }) => session.current),
    ).toHaveLength(1);

    const out = await client.request("/auth/sign-out", { body: {} });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()).toEqual([
      "ship_session=; Path=/; Max-Age=0; Secure; SameSite=Lax; HttpOnly",
    ]);
    expect(client.jar.names()).toEqual(["ship_csrf"]);
    expect((await client.request("/auth/me", { origin: null })).status).toBe(401);
  });

  it("lets bearer and cookie sessions coexist, clears the cookie on revoke-all and treats a stale cookie as anonymous on public operations", async () => {
    const fixture = createFixture({
      sessions: { transport: "both" },
      trustedOrigins: [APP_ORIGIN],
    });
    await fixture.start();
    const bearer = await registerAndSignIn(fixture);
    expect(bearer.session).toMatchObject({ transport: "bearer", token: expect.any(String) });
    const client = browser(fixture, "https://app.example.test");
    await client.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "cookie" },
    });
    // The bearer wins when both are presented, and both sessions are live.
    const both = await fixture.request("/auth/me", {
      token: bearer.session.token,
      headers: { cookie: client.jar.header() as string },
    });
    expect(both.body.session.id).toBe(bearer.session.id);
    const list = await client.request("/auth/sessions", { origin: null });
    expect(list.body.sessions).toHaveLength(2);

    // Revoke-all from the cookie session: the cookie is cleared, the bearer is dead too.
    const all = await client.request("/auth/sessions/revoke-all", { body: {} });
    expect(all.body).toEqual({ revoked: 2 });
    expect(all.headers.getSetCookie()[0]).toMatch(/^ship_session=; .*Max-Age=0/u);
    expect((await fixture.request("/auth/me", { token: bearer.session.token })).status).toBe(401);

    // A browser that still carries the revoked cookie: public operations resolve
    // anonymously so sign-in can replace it; authenticated ones refuse.
    const stale = `ship_session=${client.jar.get("ship_session")?.value ?? "gone"}`;
    const staleJar = createCookieJar();
    staleJar.absorb(
      new Headers({
        "set-cookie": `ship_session=${"b".repeat(43).replace(/^/u, "ship_s_")}; Path=/`,
      }),
    );
    const staleCookie = staleJar.header() as string;
    expect(stale).toBe("ship_session=gone");
    // Refused, and the browser is told to drop the dead cookie; the presentation is audited once.
    const refused = await fixture.request("/auth/me", { headers: { cookie: staleCookie } });
    expect(refused.status).toBe(401);
    expect(refused.headers.getSetCookie()).toEqual([
      "ship_session=; Path=/; Max-Age=0; Secure; SameSite=Lax; HttpOnly",
    ]);
    expect(
      fixture.store.auditEvents().filter((event) => event.event === "session.stale-cookie"),
    ).toEqual([
      expect.objectContaining({
        outcome: "failure",
        ip: "203.0.113.7",
        details: { reason: "unknown", operation: "auth.me" },
      }),
    ]);
    // The revoked cookie the browser still holds names its old session and account.
    const revokedCookie = `ship_session=${client.jar.get("ship_session")?.value ?? ""}`;
    const revokedSession = (await fixture.store.listSessions(bearer.account.id)).find(
      (session) => session.id !== bearer.session.id,
    );
    if (revokedCookie !== "ship_session=") {
      const again = await fixture.request("/auth/sessions", { headers: { cookie: revokedCookie } });
      expect(again.status).toBe(401);
      expect(fixture.store.auditEvents().at(-1)).toMatchObject({
        event: "session.stale-cookie",
        accountId: bearer.account.id,
        sessionId: revokedSession?.id,
        details: { reason: "revoked", operation: "auth.sessions.list" },
      });
    }
    const replaced = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "cookie" },
      headers: {
        cookie: `${staleCookie}; ship_csrf=old`,
        origin: "https://app.example.test",
        "x-csrf-token": "old",
      },
    });
    expect(replaced.status).toBe(200);
    // The fresh cookie alone: the clearing instruction never follows a replacement.
    expect(replaced.headers.getSetCookie().filter((c) => c.startsWith("ship_session="))).toEqual([
      expect.stringMatching(/^ship_session=ship_s_/u),
    ]);
    expect(fixture.store.auditEvents().at(-2)).toMatchObject({
      event: "session.stale-cookie",
      details: { reason: "unknown", operation: "auth.sign-in" },
    });
    // A malformed cookie is also just absent on a public operation (the CSRF
    // policy still gates the unsafe method, since a session cookie is present),
    // and it is cleared and audited like any other stale one.
    const malformed = await fixture.request("/auth/resend-verification", {
      body: { email: EMAIL },
      headers: {
        cookie: "ship_session=garbage; ship_csrf=x",
        origin: APP_ORIGIN,
        "x-csrf-token": "x",
      },
    });
    expect(malformed.status).toBe(202);
    expect(malformed.headers.getSetCookie()).toEqual([
      "ship_session=; Path=/; Max-Age=0; Secure; SameSite=Lax; HttpOnly",
    ]);
    expect(
      fixture.store.auditEvents().find((event) => event.details?.reason === "malformed"),
    ).toMatchObject({ event: "session.stale-cookie" });
    expect(
      (
        await fixture.request("/auth/resend-verification", {
          body: { email: EMAIL },
          headers: { cookie: "ship_session=garbage" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fixture.request("/auth/me", { headers: { cookie: "ship_session=garbage" } })).status,
    ).toBe(401);
    // A present invalid bearer is still refused everywhere (ADR-0004).
    expect(
      (
        await fixture.request("/auth/resend-verification", {
          body: { email: EMAIL },
          headers: { authorization: "Bearer garbage" },
        })
      ).status,
    ).toBe(401);
  });

  it("rotates the cookie session on MFA enrolment, keeps a bearer session in place, and clears the cookie when the current session is revoked", async () => {
    const fixture = createFixture({
      sessions: { transport: "both" },
      trustedOrigins: [APP_ORIGIN],
    });
    await fixture.start();
    const bearer = await registerAndSignIn(fixture, "bearer@example.test");
    const client = browser(fixture, "https://app.example.test");
    const signedIn = await client.request("/auth/sign-in", {
      body: { email: "bearer@example.test", password: PASSWORD, transport: "cookie" },
    });
    const before = client.jar.get("ship_session")?.value as string;

    const enrol = await client.request("/auth/totp/enrol", { body: { password: PASSWORD } });
    expect(enrol.status).toBe(200);
    const confirm = await client.request("/auth/totp/confirm", {
      body: { code: totpCode(enrol.body.secret, totpStep(fixture.clock())) },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.session).toEqual({
      transport: "cookie",
      id: expect.any(String),
      expiresAt: expect.any(String),
      mfaState: "verified",
    });
    expect(confirm.body.session.id).not.toBe(signedIn.body.session.id);
    const after = client.jar.get("ship_session")?.value as string;
    expect(after).not.toBe(before);
    expect(
      (await fixture.request("/auth/me", { headers: { cookie: `ship_session=${before}` } })).status,
    ).toBe(401);
    const me = await client.request("/auth/me", { origin: null });
    expect(me.body.session).toMatchObject({ id: confirm.body.session.id, mfaState: "verified" });
    const rotatedRow = await fixture.store.findSession(signedIn.body.session.id);
    expect(rotatedRow).toMatchObject({ revokedReason: "rotated" });
    expect(
      fixture.store.auditEvents().find((event) => event.event === "mfa.enrolled"),
    ).toMatchObject({
      sessionId: signedIn.body.session.id,
      details: { rotatedTo: confirm.body.session.id },
    });

    // The bearer session that enrols keeps its token.
    const other = await registerAndSignIn(fixture, "other@example.test");
    const otherEnrol = await fixture.request("/auth/totp/enrol", {
      token: other.session.token,
      body: { password: PASSWORD },
    });
    fixture.advance(60_000);
    const otherConfirm = await fixture.request("/auth/totp/confirm", {
      token: other.session.token,
      body: { code: totpCode(otherEnrol.body.secret, totpStep(fixture.clock())) },
    });
    expect(otherConfirm.status).toBe(200);
    expect(otherConfirm.body.session).toBeUndefined();
    expect(
      (await fixture.request("/auth/me", { token: other.session.token })).body.session,
    ).toMatchObject({
      mfaState: "verified",
    });

    // The MFA challenge answered over the cookie transport installs a verified cookie.
    fixture.advance(60_000);
    const challenged = await client.request("/auth/sign-in", {
      body: { email: "bearer@example.test", password: PASSWORD, transport: "cookie" },
    });
    expect(challenged.body.status).toBe("mfa-required");
    const verified = await client.request("/auth/totp/verify", {
      body: {
        challenge: challenged.body.challenge.token,
        code: totpCode(enrol.body.secret, totpStep(fixture.clock())),
        transport: "cookie",
      },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.session).toMatchObject({ transport: "cookie", mfaState: "verified" });
    expect(verified.body.session.token).toBeUndefined();
    expect(client.jar.get("ship_session")?.value).not.toBe(after);

    // Revoking the current session by id takes the cookie with it.
    const current = (await client.request("/auth/me", { origin: null })).body.session.id;
    const revoked = await client.request("/auth/sessions/revoke", { body: { sessionId: current } });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.getSetCookie()[0]).toMatch(/^ship_session=; /u);
    expect(client.jar.names()).not.toContain("ship_session");
    expect(bearer.session.transport).toBe("bearer");
  });

  it("rotates the cookie session on a password change and signs the other sessions out", async () => {
    const fixture = createFixture({
      sessions: { transport: "both" },
      trustedOrigins: [APP_ORIGIN],
    });
    await fixture.start();
    const bearer = await registerAndSignIn(fixture);
    const client = browser(fixture);
    const signedIn = await client.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "cookie" },
    });
    expect(signedIn.status).toBe(200);
    const before = client.jar.get("ship_session")?.value as string;

    const changed = await client.request("/auth/password/change", {
      body: { currentPassword: PASSWORD, newPassword: "another correct horse" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({
      changed: true,
      revoked: 1,
      notified: true,
      session: {
        transport: "cookie",
        id: expect.any(String),
        expiresAt: expect.any(String),
        mfaState: "none",
      },
    });
    const after = client.jar.get("ship_session")?.value as string;
    expect(after).not.toBe(before);
    expect(client.jar.get("ship_session")?.attributes).toContain("HttpOnly");
    expect(
      (await fixture.request("/auth/me", { headers: { cookie: `ship_session=${before}` } })).status,
    ).toBe(401);
    expect((await fixture.request("/auth/me", { token: bearer.session.token })).status).toBe(401);
    const me = await client.request("/auth/me", { origin: null });
    expect(me.status).toBe(200);
    expect(me.body.session.id).toBe(changed.body.session.id);
    expect(await fixture.store.findSession(signedIn.body.session.id)).toMatchObject({
      revokedReason: "rotated",
    });
    expect(await fixture.store.findSession(bearer.session.id)).toMatchObject({
      revokedReason: "password-changed",
    });
    // The change is CSRF-guarded like every other write from a cookie session.
    const unguarded = await client.request("/auth/password/change", {
      body: { currentPassword: "another correct horse", newPassword: PASSWORD },
      csrf: false,
    });
    expect(unguarded.status).toBe(403);
  });

  it("validates the requested transport against the enabled ones", async () => {
    const cookieOnly = createFixture({
      sessions: { transport: "cookie" },
      trustedOrigins: [APP_ORIGIN],
    });
    await cookieOnly.start();
    const registered = await cookieOnly.request("/auth/register", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(registered.status).toBe(201);
    const [mail] = await cookieOnly.deliverMail();
    await cookieOnly.request("/auth/verify-email", { body: { token: mail?.token } });
    const bearerRefused = await cookieOnly.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "bearer" },
    });
    expect(bearerRefused.status).toBe(400);
    expect(bearerRefused.body.error.code).toBe("VALIDATION_ERROR");
    const implicit = await cookieOnly.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
      headers: { origin: "https://app.example.test" },
    });
    expect(implicit.status).toBe(200);
    expect(implicit.body.session.transport).toBe("cookie");
    expect(implicit.headers.getSetCookie().map((line) => line.split("=")[0])).toEqual([
      "ship_session",
      "ship_csrf",
    ]);

    const bearerOnly = createFixture();
    await bearerOnly.start();
    await registerAndSignIn(bearerOnly);
    const cookieRefused = await bearerOnly.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "cookie" },
    });
    expect(cookieRefused.status).toBe(400);
    // A bearer-only module ignores a session cookie entirely.
    expect(
      (
        await bearerOnly.request("/auth/me", {
          headers: { cookie: `ship_session=${TOKEN}` },
        })
      ).status,
    ).toBe(401);
  });
});
