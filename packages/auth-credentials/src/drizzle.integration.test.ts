import {
  type PostgresTestDb,
  setupPostgresTestDb,
  truncateAll,
} from "@sixthsummit/ship-testing/postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCookieJar,
  createFixture,
  EMAIL,
  PASSWORD,
  registerAndSignIn,
} from "./__fixtures__/app.js";
import { credentialStoreConformance } from "./conformance.js";
import { totpCode, totpStep } from "./crypto/totp.js";
import { createDrizzleCredentialStore, shipAuthTables } from "./drizzle.js";

const tables = shipAuthTables();

describe("Drizzle credential store against PostgreSQL", () => {
  let database: PostgresTestDb<typeof tables>;

  beforeAll(async () => {
    database = await setupPostgresTestDb(tables);
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  credentialStoreConformance(
    "drizzle",
    {
      create: async () => {
        await truncateAll(database);
        return createDrizzleCredentialStore({ database: database.db, tables });
      },
    },
    { describe, it, beforeEach, expect },
  );

  it("runs the full credential flow over HTTP with the PostgreSQL store", async () => {
    await truncateAll(database);
    const store = createDrizzleCredentialStore({ database: database.db, tables });
    const fixture = createFixture({
      store,
      policies: { lockout: { threshold: 2, windowMs: 60_000, durationMs: 60_000 } },
    });
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    expect(signedIn.status).toBe("signed-in");

    // Lockout and reset through real conditional updates.
    await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: "wrong" } });
    await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: "wrong" } });
    expect(
      (await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(423);
    await fixture.request("/auth/password/forgot", { body: { email: EMAIL } });
    const [reset] = await fixture.deliverMail();
    expect(
      (
        await fixture.request("/auth/password/reset", {
          body: { token: reset?.token, password: "another long passphrase" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.request("/auth/password/reset", {
          body: { token: reset?.token, password: "another long passphrase" },
        })
      ).status,
    ).toBe(400);
    expect((await fixture.request("/auth/me", { token: signedIn.session.token })).status).toBe(401);

    // TOTP enrolment, challenge, replay guard and a recovery code, all on the PostgreSQL rows.
    const fresh = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: "another long passphrase" },
    });
    const token = fresh.body.session.token as string;
    const enrol = await fixture.request("/auth/totp/enrol", {
      token,
      body: { password: "another long passphrase" },
    });
    const secret = enrol.body.secret as string;
    const confirm = await fixture.request("/auth/totp/confirm", {
      token,
      body: { code: totpCode(secret, totpStep(fixture.clock())) },
    });
    expect(confirm.status).toBe(200);
    const stored = await store.findMfaSecret(signedIn.account.id);
    expect(stored?.enabledAt).toBeDefined();
    expect(stored?.secretCiphertext.startsWith("v1.k1.")).toBe(true);
    fixture.advance(60_000);
    const challenge = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: "another long passphrase" },
    });
    expect(challenge.body.status).toBe("mfa-required");
    const code = totpCode(secret, totpStep(fixture.clock()));
    const verified = await fixture.request("/auth/totp/verify", {
      body: { challenge: challenge.body.challenge.token, code },
    });
    expect(verified.status).toBe(200);
    const second = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: "another long passphrase" },
    });
    expect(
      (
        await fixture.request("/auth/totp/verify", {
          body: { challenge: second.body.challenge.token, code },
        })
      ).status,
    ).toBe(401);
    const recovered = await fixture.request("/auth/recovery/consume", {
      body: { challenge: second.body.challenge.token, code: confirm.body.recoveryCodes[0] },
    });
    expect(recovered.body).toMatchObject({ status: "signed-in", recoveryCodesRemaining: 9 });

    // Revoke-all through the account cutoff is honoured by the resolver on the next request.
    const list = await fixture.request("/auth/sessions", { token: verified.body.session.token });
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(2);
    await fixture.request("/auth/sessions/revoke-all", {
      token: verified.body.session.token,
      body: {},
    });
    expect((await fixture.request("/auth/me", { token: verified.body.session.token })).status).toBe(
      401,
    );
    expect(
      (await fixture.request("/auth/me", { token: recovered.body.session.token })).status,
    ).toBe(401);

    const audit = await store.listAudit({ accountId: signedIn.account.id, limit: 100 });
    expect(audit.map((event) => event.event)).toContain("sessions.revoke-all");
    expect(audit.map((event) => event.event)).toContain("mfa.recover");
    for (const event of audit) expect(JSON.stringify(event)).not.toContain("ship_");
  });

  it("runs cookie sessions beside bearer sessions on PostgreSQL, and revoke-all ends the cookie mid-request", async () => {
    await truncateAll(database);
    const store = createDrizzleCredentialStore({ database: database.db, tables });
    const origin = "https://app.example.test";
    const fixture = createFixture({
      store,
      sessions: { transport: "both" },
      trustedOrigins: [origin],
    });
    await fixture.start();
    const bearer = await registerAndSignIn(fixture);
    const jar = createCookieJar();
    const browser = async (
      path: string,
      init: { readonly body?: unknown; readonly csrf?: boolean } = {},
    ) => {
      const cookie = jar.header();
      const csrf = jar.get("ship_csrf")?.value;
      const response = await fixture.request(path, {
        ...(init.body !== undefined ? { body: init.body } : {}),
        headers: {
          ...(cookie ? { cookie } : {}),
          origin,
          ...(init.csrf !== false && csrf ? { "x-csrf-token": csrf } : {}),
        },
      });
      jar.absorb(response.headers);
      return response;
    };

    // Sign in over the cookie: the row is a real session, the token is only in the jar.
    const signedIn = await browser("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "cookie" },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.session.token).toBeUndefined();
    const rows = await store.listSessions(bearer.account.id);
    expect(rows).toHaveLength(2);
    expect(jar.get("ship_session")?.value).toMatch(/^ship_s_/u);

    // Reload-safe: a fresh request with nothing but the cookie is the same session.
    const me = await browser("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.session.id).toBe(signedIn.body.session.id);
    expect((await browser("/app/slow", { body: {}, csrf: false })).status).toBe(403);

    // Revoke-all (from the bearer session, through the executor) while a cookie
    // request is in flight: the authorized request finishes, the next one is refused.
    const entered = new Promise<void>((resolve) => {
      fixture.gate.entered = resolve;
    });
    const inFlight = browser("/app/slow", { body: {} });
    await entered;
    const revoked = await fixture.executor.run(
      "auth.sessions.revoke-all",
      { body: {} },
      {
        actor: { id: bearer.account.id },
        identity: { provider: "ship-credentials.session", subject: bearer.session.id },
      },
    );
    expect(revoked).toMatchObject({ ok: true, data: { revoked: 2 } });
    fixture.gate.release();
    expect((await inFlight).status).toBe(200);
    expect((await browser("/auth/me")).status).toBe(401);
    expect((await fixture.request("/auth/me", { token: bearer.session.token })).status).toBe(401);
    // The stale cookie does not block a new sign-in, which replaces it.
    const again = await browser("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD, transport: "cookie" },
    });
    expect(again.status).toBe(200);
    expect((await browser("/auth/me")).body.session.id).toBe(again.body.session.id);
    const audit = await store.listAudit({ accountId: bearer.account.id, limit: 100 });
    for (const event of audit) expect(JSON.stringify(event)).not.toContain("ship_s_");
  });
});
