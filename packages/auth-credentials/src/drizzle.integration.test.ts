import {
  type PostgresTestDb,
  setupPostgresTestDb,
  truncateAll,
} from "@sixthsummit/ship-testing/postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixture, EMAIL, PASSWORD, registerAndSignIn } from "./__fixtures__/app.js";
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
});
