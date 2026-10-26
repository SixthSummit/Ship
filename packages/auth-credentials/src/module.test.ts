import { dependency } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import {
  createFixture,
  EMAIL,
  fixtureMailer,
  KEY_RING,
  PASSWORD,
  registerAndSignIn,
} from "./__fixtures__/app.js";
import { totpCode, totpStep } from "./crypto/totp.js";
import { InvalidCredentialAuthDefinitionError } from "./errors.js";
import { defineCredentialAuthMailer } from "./mailer.js";
import { createInMemoryCredentialStore } from "./memory-store.js";
import type { CredentialAuthModuleOptions } from "./module.js";
import { defineCredentialAuthModule } from "./module.js";

const links = {
  verifyEmail: (token: string) => `https://x.test/v/${token}`,
  resetPassword: (token: string) => `https://x.test/r/${token}`,
  changeEmail: (token: string) => `https://x.test/e/${token}`,
  signIn: "https://x.test/sign-in",
};

describe("defineCredentialAuthModule", () => {
  it("composes every flow as declared operations under the module id and base path", () => {
    const fixture = createFixture();
    const ids = fixture.auth.operations.map((operation) => operation.id);
    expect(ids).toEqual([
      "auth.register",
      "auth.verify-email",
      "auth.resend-verification",
      "auth.sign-in",
      "auth.sign-out",
      "auth.me",
      "auth.sessions.list",
      "auth.sessions.revoke",
      "auth.sessions.revoke-all",
      "auth.forgot-password",
      "auth.reset-password",
      "auth.change-password",
      "auth.change-email",
      "auth.confirm-email-change",
      "auth.totp.enrol",
      "auth.totp.confirm",
      "auth.totp.verify",
      "auth.recovery.consume",
    ]);
    expect(fixture.auth.mailers.map((mailer) => mailer.id)).toEqual(["auth.mailer"]);
    expect(fixture.app.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(fixture.app.graph.mailers.map((mailer) => mailer.id)).toContain("auth.mailer");
  });

  it("validates its options at definition time", () => {
    const store = createInMemoryCredentialStore();
    const mail = dependency("mail.deliver") as CredentialAuthModuleOptions["mail"];
    const base = { store, mailer: fixtureMailer, mail, links, secrets: KEY_RING };
    expect(() => defineCredentialAuthModule({ ...base, id: "Bad Id" })).toThrow(
      InvalidCredentialAuthDefinitionError,
    );
    expect(() => defineCredentialAuthModule({ ...base, basePath: "auth/" })).toThrow(/basePath/u);
    expect(() => defineCredentialAuthModule({ ...base, store: {} as never })).toThrow(/store/u);
    expect(() =>
      defineCredentialAuthModule({
        ...base,
        mailer: defineCredentialAuthMailer({ id: "other.mailer", appName: "x" }),
      }),
    ).toThrow(/namespaced/u);
    expect(() =>
      defineCredentialAuthModule({ ...base, secrets: { current: "k9", keys: {} } }),
    ).toThrow(/key ring/u);
    expect(() =>
      defineCredentialAuthModule({ ...base, policies: { lockout: { threshold: 0 } } }),
    ).toThrow(/lockout.threshold/u);
    expect(() => defineCredentialAuthModule({ ...base, links: {} as never })).toThrow(/links/u);
    expect(() => defineCredentialAuthMailer({ appName: "" })).toThrow(/appName/u);
  });
});

describe("registration and email verification", () => {
  it("registers, mails a single-use verification link and only then allows sign-in", async () => {
    const fixture = createFixture();
    await fixture.start();
    const registered = await fixture.request("/auth/register", {
      body: { email: "Ada@Example.test ", password: PASSWORD, name: "Ada" },
    });
    expect(registered.status).toBe(201);
    expect(registered.body).toEqual({ status: "verification-sent" });

    const unverified = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe("AUTH_EMAIL_UNVERIFIED");

    const [mail] = await fixture.deliverMail();
    expect(mail).toMatchObject({ to: [EMAIL], message: "verifyEmail" });
    expect(mail?.url).toMatch(/^https:\/\/app\.example\.test\/verify\/ship_t_/u);

    const verified = await fixture.request("/auth/verify-email", { body: { token: mail?.token } });
    expect(verified.status).toBe(200);
    const replay = await fixture.request("/auth/verify-email", { body: { token: mail?.token } });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("AUTH_TOKEN_INVALID");

    const signedIn = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({
      status: "signed-in",
      session: { mfaState: "none" },
      account: { email: EMAIL, name: "Ada", emailVerified: true, mfaEnabled: false, roles: [] },
    });
    expect(signedIn.body.session.token).toMatch(/^ship_s_[A-Za-z0-9_-]{43}$/u);

    const me = await fixture.request("/auth/me", { token: signedIn.body.session.token });
    expect(me.status).toBe(200);
    expect(me.body.session).toMatchObject({
      current: true,
      ip: "203.0.113.7",
      userAgent: "fixture/1.0",
    });

    const events = fixture.store.auditEvents().map((event) => `${event.event}:${event.outcome}`);
    expect(events).toEqual([
      "register:success",
      "sign-in:failure",
      "email.verify:success",
      "email.verify:failure",
      "sign-in:success",
    ]);
    expect(fixture.store.auditEvents()[0]).toMatchObject({
      ip: "203.0.113.7",
      userAgent: "fixture/1.0",
    });
    for (const event of fixture.store.auditEvents()) {
      expect(JSON.stringify(event)).not.toContain("ship_");
    }
  });

  it("expires the verification token after its ttl and lets it be re-requested", async () => {
    const fixture = createFixture();
    await fixture.start();
    await fixture.request("/auth/register", { body: { email: EMAIL, password: PASSWORD } });
    const [first] = await fixture.deliverMail();
    fixture.advance(24 * 60 * 60_000 + 1);
    const expired = await fixture.request("/auth/verify-email", { body: { token: first?.token } });
    expect(expired.status).toBe(400);

    const resent = await fixture.request("/auth/resend-verification", { body: { email: EMAIL } });
    expect(resent.status).toBe(202);
    const unknown = await fixture.request("/auth/resend-verification", {
      body: { email: "nobody@example.test" },
    });
    expect(unknown.status).toBe(202);
    const mails = await fixture.deliverMail();
    expect(mails).toHaveLength(1);
    const verified = await fixture.request("/auth/verify-email", {
      body: { token: mails[0]?.token },
    });
    expect(verified.status).toBe(200);
  });

  it("conceals a taken email by default: re-verifies an unverified account and notifies a verified one", async () => {
    const fixture = createFixture();
    await fixture.start();
    await fixture.request("/auth/register", { body: { email: EMAIL, password: PASSWORD } });
    expect((await fixture.deliverMail()).map((mail) => mail.message)).toEqual(["verifyEmail"]);

    // Unverified duplicate: same 201, the verification link goes out again,
    // and the original password is what the account keeps.
    const unverified = await fixture.request("/auth/register", {
      body: { email: EMAIL, password: "a completely different passphrase" },
    });
    expect(unverified.status).toBe(201);
    const resent = await fixture.deliverMail();
    expect(resent.map((mail) => mail.message)).toEqual(["verifyEmail"]);
    expect(
      (await fixture.request("/auth/verify-email", { body: { token: resent[0]?.token } })).status,
    ).toBe(200);

    // Verified duplicate: same 201, and the owner gets a notice that links to sign-in.
    const verified = await fixture.request("/auth/register", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(verified.status).toBe(201);
    const notice = await fixture.deliverMail();
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ message: "existingAccount" });
    expect([notice[0]?.to].flat()).toContain(EMAIL);
    expect(notice[0]?.url.endsWith("/sign-in")).toBe(true);
    expect(
      (await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(200);
  });

  it("rejects a taken email with 409 when configured, and refuses conceal without a sign-in link", async () => {
    const rejecting = createFixture({ onExistingEmail: "reject" });
    await rejecting.start();
    await rejecting.request("/auth/register", { body: { email: EMAIL, password: PASSWORD } });
    const taken = await rejecting.request("/auth/register", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("AUTH_EMAIL_TAKEN");

    expect(() => createFixture({ signInLink: null })).toThrow(/links\.signIn/u);
    expect(() => createFixture({ signInLink: null, onExistingEmail: "reject" })).not.toThrow();
  });

  it("enforces the password policy on register and reset", async () => {
    const fixture = createFixture({ policies: { password: { minLength: 16 } } });
    const short = await fixture.request("/auth/register", {
      body: { email: EMAIL, password: "too short" },
    });
    expect(short.status).toBe(422);
    expect(short.body.error).toMatchObject({
      code: "AUTH_PASSWORD_POLICY",
      details: { minLength: 16, maxLength: 256 },
    });
  });
});

describe("sign-in, lockout and sessions", () => {
  it("answers the same failure for an unknown email and a wrong password, then locks and unlocks", async () => {
    const fixture = createFixture({
      policies: { lockout: { threshold: 3, windowMs: 60_000, durationMs: 120_000 } },
    });
    await fixture.start();
    await registerAndSignIn(fixture);

    const unknown = await fixture.request("/auth/sign-in", {
      body: { email: "nobody@example.test", password: PASSWORD },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");

    const wrong = () =>
      fixture.request("/auth/sign-in", { body: { email: EMAIL, password: "wrong password!!" } });
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    const locked = await wrong();
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("AUTH_ACCOUNT_LOCKED");
    expect(locked.headers.get("retry-after")).toBe("120");

    // The right password does not open a locked account.
    const stillLocked = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(stillLocked.status).toBe(423);
    expect(Number(stillLocked.headers.get("retry-after"))).toBeLessThanOrEqual(120);

    // Lockout reset: once the lock lapses the counter starts over.
    fixture.advance(120_001);
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    const ok = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(ok.status).toBe(200);
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(423);

    const events = fixture.store.auditEvents().map((event) => event.event);
    expect(events.filter((event) => event === "sign-in.locked")).toHaveLength(2);
  });

  it("lists, revokes one, revokes all, and honours the cutoff for a session created in between", async () => {
    const fixture = createFixture();
    await fixture.start();
    const first = await registerAndSignIn(fixture);
    fixture.advance(1_000);
    const second = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const list = await fixture.request("/auth/sessions", { token: first.session.token });
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((session: { current: boolean }) => session.current)).toEqual([
      false,
      true,
    ]);

    const revoked = await fixture.request("/auth/sessions/revoke", {
      token: first.session.token,
      body: { sessionId: second.body.session.id },
    });
    expect(revoked.body).toEqual({ revoked: 1 });
    expect((await fixture.request("/auth/me", { token: second.body.session.token })).status).toBe(
      401,
    );
    const again = await fixture.request("/auth/sessions/revoke", {
      token: first.session.token,
      body: { sessionId: second.body.session.id },
    });
    expect(again.status).toBe(404);

    const kept = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const all = await fixture.request("/auth/sessions/revoke-all", {
      token: first.session.token,
      body: { keepCurrent: true },
    });
    expect(all.body).toEqual({ revoked: 1 });
    expect((await fixture.request("/auth/me", { token: kept.body.session.token })).status).toBe(
      401,
    );
    expect((await fixture.request("/auth/me", { token: first.session.token })).status).toBe(200);

    const everything = await fixture.request("/auth/sessions/revoke-all", {
      token: first.session.token,
      body: {},
    });
    expect(everything.body).toEqual({ revoked: 1 });
    expect((await fixture.request("/auth/me", { token: first.session.token })).status).toBe(401);
  });

  it("lets a request that was authorized before revoke-all finish, then refuses the next one", async () => {
    const fixture = createFixture();
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    const entered = new Promise<void>((resolve) => {
      fixture.gate.entered = resolve;
    });
    const inFlight = fixture.request("/app/slow", { token: signedIn.session.token, body: {} });
    await entered;
    const executor = fixture.executor;
    const revoked = await executor.run(
      "auth.sessions.revoke-all",
      { body: {} },
      {
        actor: { id: signedIn.account.id },
        identity: { provider: "ship-credentials.session", subject: signedIn.session.id },
      },
    );
    expect(revoked).toMatchObject({ ok: true, data: { revoked: 1 } });
    fixture.gate.release();
    const finished = await inFlight;
    expect(finished.status).toBe(200);
    expect(finished.body).toEqual({ actorId: signedIn.account.id });
    const next = await fixture.request("/app/slow", { token: signedIn.session.token, body: {} });
    expect(next.status).toBe(401);
  });

  it("signs out the current session and expires sessions by age and idleness", async () => {
    const fixture = createFixture({
      policies: { session: { maxAgeMs: 3_600_000, idleTimeoutMs: 600_000, touchIntervalMs: 0 } },
    });
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    const out = await fixture.request("/auth/sign-out", {
      token: signedIn.session.token,
      body: {},
    });
    expect(out.body).toEqual({ signedOut: true });
    expect((await fixture.request("/auth/me", { token: signedIn.session.token })).status).toBe(401);

    const idle = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    fixture.advance(500_000);
    expect((await fixture.request("/auth/me", { token: idle.body.session.token })).status).toBe(
      200,
    );
    fixture.advance(500_000);
    expect((await fixture.request("/auth/me", { token: idle.body.session.token })).status).toBe(
      200,
    );
    fixture.advance(600_001);
    expect((await fixture.request("/auth/me", { token: idle.body.session.token })).status).toBe(
      401,
    );

    const aged = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    for (let step = 0; step < 8; step += 1) {
      fixture.advance(500_000);
      await fixture.request("/auth/me", { token: aged.body.session.token });
    }
    expect((await fixture.request("/auth/me", { token: aged.body.session.token })).status).toBe(
      401,
    );
  });

  it("refuses a malformed bearer and a disabled account", async () => {
    const fixture = createFixture();
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    expect(
      (await fixture.request("/auth/me", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (await fixture.request("/auth/me", { headers: { authorization: "Token x" } })).status,
    ).toBe(401);
    await fixture.store.updateAccount(signedIn.account.id, { status: "disabled" }, fixture.clock());
    expect((await fixture.request("/auth/me", { token: signedIn.session.token })).status).toBe(403);
    const signIn = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(signIn.status).toBe(403);
    expect(signIn.body.error.code).toBe("AUTH_ACCOUNT_DISABLED");
  });
});

describe("password reset and email change", () => {
  it("resets through a single-use mailed token, clearing the lock and every session", async () => {
    const fixture = createFixture({
      policies: { lockout: { threshold: 2, windowMs: 60_000, durationMs: 60_000 } },
    });
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: "wrong" } });
    await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: "wrong" } });
    expect(
      (await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(423);

    expect(
      (await fixture.request("/auth/password/forgot", { body: { email: "nobody@example.test" } }))
        .status,
    ).toBe(202);
    expect(await fixture.deliverMail()).toEqual([]);
    expect(
      (await fixture.request("/auth/password/forgot", { body: { email: EMAIL } })).status,
    ).toBe(202);
    const [mail] = await fixture.deliverMail();
    expect(mail).toMatchObject({ message: "resetPassword", to: [EMAIL] });

    const weak = await fixture.request("/auth/password/reset", {
      body: { token: mail?.token, password: "short" },
    });
    expect(weak.status).toBe(422);
    const reset = await fixture.request("/auth/password/reset", {
      body: { token: mail?.token, password: "a brand new passphrase" },
    });
    expect(reset.body).toEqual({ reset: true });
    const replay = await fixture.request("/auth/password/reset", {
      body: { token: mail?.token, password: "a brand new passphrase" },
    });
    expect(replay.status).toBe(400);

    expect((await fixture.request("/auth/me", { token: signedIn.session.token })).status).toBe(401);
    const old = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(old.status).toBe(401);
    const fresh = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: "a brand new passphrase" },
    });
    expect(fresh.status).toBe(200);
  });

  it("supersedes an earlier reset token and expires one after its ttl", async () => {
    const fixture = createFixture();
    await fixture.start();
    await registerAndSignIn(fixture);
    await fixture.request("/auth/password/forgot", { body: { email: EMAIL } });
    const [first] = await fixture.deliverMail();
    await fixture.request("/auth/password/forgot", { body: { email: EMAIL } });
    const [second] = await fixture.deliverMail();
    expect(
      (
        await fixture.request("/auth/password/reset", {
          body: { token: first?.token, password: PASSWORD },
        })
      ).status,
    ).toBe(400);
    fixture.advance(60 * 60_000 + 1);
    expect(
      (
        await fixture.request("/auth/password/reset", {
          body: { token: second?.token, password: PASSWORD },
        })
      ).status,
    ).toBe(400);
  });

  it("changes the email through a token mailed to the new address", async () => {
    const fixture = createFixture();
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    const token = signedIn.session.token;
    const wrong = await fixture.request("/auth/email/change", {
      token,
      body: { password: "wrong", newEmail: "ada2@example.test" },
    });
    expect(wrong.status).toBe(401);
    await fixture.request("/auth/register", {
      body: { email: "taken@example.test", password: PASSWORD },
    });
    await fixture.deliverMail();
    const taken = await fixture.request("/auth/email/change", {
      token,
      body: { password: PASSWORD, newEmail: "taken@example.test" },
    });
    expect(taken.status).toBe(409);

    const accepted = await fixture.request("/auth/email/change", {
      token,
      body: { password: PASSWORD, newEmail: "Ada2@Example.test" },
    });
    expect(accepted.status).toBe(202);
    const [mail] = await fixture.deliverMail();
    expect(mail).toMatchObject({ message: "changeEmail", to: ["ada2@example.test"] });
    const confirmed = await fixture.request("/auth/email/confirm", {
      body: { token: mail?.token },
    });
    expect(confirmed.body).toEqual({ email: "ada2@example.test" });
    const me = await fixture.request("/auth/me", { token });
    expect(me.body.account.email).toBe("ada2@example.test");
    expect(
      (await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(401);
    expect(
      (
        await fixture.request("/auth/sign-in", {
          body: { email: "ada2@example.test", password: PASSWORD },
        })
      ).status,
    ).toBe(200);
  });
});

describe("password change", () => {
  it("re-enters the password under the lockout policy, rotates the current session and signs the others out", async () => {
    const fixture = createFixture({ policies: { lockout: { threshold: 3, windowMs: 60_000 } } });
    await fixture.start();
    const first = await registerAndSignIn(fixture);
    const second = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const third = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const token = first.session.token;

    expect(
      (
        await fixture.request("/auth/password/change", {
          token,
          body: { currentPassword: PASSWORD, newPassword: "short" },
        })
      ).status,
    ).toBe(422);
    const wrong = await fixture.request("/auth/password/change", {
      token,
      body: { currentPassword: "wrong", newPassword: "another correct horse" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(
      fixture.store.auditEvents().filter((event) => event.event === "password.changed"),
    ).toMatchObject([{ outcome: "failure", details: { reason: "wrong-password", attempts: 1 } }]);
    // Wrong re-entries count towards the lockout like a failed sign-in.
    await fixture.request("/auth/password/change", {
      token,
      body: { currentPassword: "wrong", newPassword: "another correct horse" },
    });
    const locked = await fixture.request("/auth/password/change", {
      token,
      body: { currentPassword: "wrong", newPassword: "another correct horse" },
    });
    expect(locked.status).toBe(423);
    fixture.advance(16 * 60_000);

    // One other session is kept out of the sweep when asked; the current one is still rotated.
    const kept = await fixture.request("/auth/password/change", {
      token: third.body.session.token,
      body: {
        currentPassword: PASSWORD,
        newPassword: "another correct horse",
        signOutOtherSessions: false,
      },
    });
    expect(kept.status).toBe(200);
    expect(kept.body).toEqual({
      changed: true,
      revoked: 0,
      notified: true,
      session: {
        transport: "bearer",
        token: expect.stringMatching(/^ship_s_/u),
        id: expect.any(String),
        expiresAt: expect.any(String),
        mfaState: "none",
      },
    });
    expect(kept.body.session.token).not.toBe(third.body.session.token);
    expect((await fixture.request("/auth/me", { token: third.body.session.token })).status).toBe(
      401,
    );
    expect((await fixture.request("/auth/me", { token })).status).toBe(200);
    expect(await fixture.store.findSession(third.body.session.id)).toMatchObject({
      revokedReason: "rotated",
    });

    const changed = await fixture.request("/auth/password/change", {
      token,
      body: { currentPassword: "another correct horse", newPassword: PASSWORD },
    });
    expect(changed.status).toBe(200);
    // The second sign-in and the rotated third one are gone; only the new current session lives.
    expect(changed.body.revoked).toBe(2);
    expect((await fixture.request("/auth/me", { token })).status).toBe(401);
    expect((await fixture.request("/auth/me", { token: second.body.session.token })).status).toBe(
      401,
    );
    expect((await fixture.request("/auth/me", { token: kept.body.session.token })).status).toBe(
      401,
    );
    const me = await fixture.request("/auth/me", { token: changed.body.session.token });
    expect(me.status).toBe(200);
    expect(me.body.session.id).toBe(changed.body.session.id);
    expect(await fixture.store.findSession(second.body.session.id)).toMatchObject({
      revokedReason: "password-changed",
    });
    expect(
      fixture.store.auditEvents().filter((event) => event.event === "password.changed"),
    ).toContainEqual(
      expect.objectContaining({
        outcome: "success",
        accountId: first.account.id,
        sessionId: first.session.id,
        details: { sessionsRevoked: 2, rotatedTo: changed.body.session.id },
      }),
    );
    expect(
      (
        await fixture.request("/auth/sign-in", {
          body: { email: EMAIL, password: "another correct horse" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fixture.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(200);

    // Every change notifies the owner with a short-lived reset link that retakes the account.
    const notices = (await fixture.deliverMail()).filter(
      (mail) => mail.message === "passwordChanged",
    );
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ to: [EMAIL] });
    // The earlier notice's link died with the next change; the latest one works once.
    expect(
      (
        await fixture.request("/auth/password/reset", {
          body: { token: notices[0]?.token, password: "retaken by the owner" },
        })
      ).status,
    ).toBe(400);
    const retaken = await fixture.request("/auth/password/reset", {
      body: { token: notices[1]?.token, password: "retaken by the owner" },
    });
    expect(retaken.status).toBe(200);
    expect((await fixture.request("/auth/me", { token: changed.body.session.token })).status).toBe(
      401,
    );
    expect(
      (
        await fixture.request("/auth/sign-in", {
          body: { email: EMAIL, password: "retaken by the owner" },
        })
      ).status,
    ).toBe(200);
  });

  it("expires the password-changed reset link after its own short lifetime", async () => {
    const fixture = createFixture({ policies: { tokens: { passwordChangedResetTtlMs: 60_000 } } });
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    const changed = await fixture.request("/auth/password/change", {
      token: signedIn.session.token,
      body: { currentPassword: PASSWORD, newPassword: "another correct horse" },
    });
    expect(changed.status).toBe(200);
    const [notice] = (await fixture.deliverMail()).filter(
      (mail) => mail.message === "passwordChanged",
    );
    fixture.advance(60_001);
    expect(
      (
        await fixture.request("/auth/password/reset", {
          body: { token: notice?.token, password: "too late to retake it" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("TOTP MFA and recovery codes", () => {
  const code = (secret: string, now: Date, drift = 0) => totpCode(secret, totpStep(now) + drift);

  it("enrols, confirms, challenges on sign-in, refuses replayed codes and consumes recovery codes once", async () => {
    const fixture = createFixture();
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    const token = signedIn.session.token;

    expect(
      (await fixture.request("/auth/totp/enrol", { token, body: { password: "wrong" } })).status,
    ).toBe(401);
    expect(
      (await fixture.request("/auth/totp/confirm", { token, body: { code: "000000" } })).status,
    ).toBe(409);
    const enrol = await fixture.request("/auth/totp/enrol", {
      token,
      body: { password: PASSWORD },
    });
    expect(enrol.status).toBe(200);
    expect(enrol.body.secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(enrol.body.otpauthUrl).toContain(`secret=${enrol.body.secret}`);
    expect(enrol.body.otpauthUrl).toContain("issuer=Fixture+App");
    const secret = enrol.body.secret as string;
    const stored = await fixture.store.findMfaSecret(signedIn.account.id);
    expect(stored?.secretCiphertext).not.toContain(secret);
    expect(stored?.keyId).toBe("k1");

    const badConfirm = await fixture.request("/auth/totp/confirm", {
      token,
      body: { code: "123456" },
    });
    expect(badConfirm.status).toBe(401);
    expect(badConfirm.body.error.code).toBe("AUTH_MFA_INVALID_CODE");
    const confirm = await fixture.request("/auth/totp/confirm", {
      token,
      body: { code: code(secret, fixture.clock()) },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    const codes: string[] = confirm.body.recoveryCodes;
    expect(codes[0]).toMatch(/^[a-z2-9]{5}(?:-[a-z2-9]{5}){3}$/u);
    const me = await fixture.request("/auth/me", { token });
    expect(me.body).toMatchObject({
      account: { mfaEnabled: true },
      session: { mfaState: "verified" },
    });
    expect(
      (await fixture.request("/auth/totp/enrol", { token, body: { password: PASSWORD } })).status,
    ).toBe(409);

    fixture.advance(60_000);
    const challenge = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(challenge.body.status).toBe("mfa-required");
    expect(challenge.body.challenge.token).toMatch(/^ship_c_/u);
    const challengeToken = challenge.body.challenge.token as string;

    const wrongCode = await fixture.request("/auth/totp/verify", {
      body: { challenge: challengeToken, code: "000000" },
    });
    expect(wrongCode.status).toBe(401);
    const good = code(secret, fixture.clock());
    const verified = await fixture.request("/auth/totp/verify", {
      body: { challenge: challengeToken, code: good },
    });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ status: "signed-in", session: { mfaState: "verified" } });
    // The challenge is single-use and the step is burnt even for a fresh challenge.
    expect(
      (
        await fixture.request("/auth/totp/verify", {
          body: { challenge: challengeToken, code: good },
        })
      ).status,
    ).toBe(400);
    const second = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const replayed = await fixture.request("/auth/totp/verify", {
      body: { challenge: second.body.challenge.token, code: good },
    });
    expect(replayed.status).toBe(401);
    const drifted = await fixture.request("/auth/totp/verify", {
      body: { challenge: second.body.challenge.token, code: code(secret, fixture.clock(), 1) },
    });
    expect(drifted.status).toBe(200);

    const third = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const badRecovery = await fixture.request("/auth/recovery/consume", {
      body: { challenge: third.body.challenge.token, code: "aaaaa-bbbbb-ccccc-ddddd" },
    });
    expect(badRecovery.status).toBe(401);
    expect(badRecovery.body.error.code).toBe("AUTH_RECOVERY_CODE_INVALID");
    const recovered = await fixture.request("/auth/recovery/consume", {
      body: { challenge: third.body.challenge.token, code: (codes[3] as string).toUpperCase() },
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ status: "signed-in", recoveryCodesRemaining: 9 });
    const fourth = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const reused = await fixture.request("/auth/recovery/consume", {
      body: { challenge: fourth.body.challenge.token, code: codes[3] },
    });
    expect(reused.status).toBe(401);

    fixture.advance(5 * 60_000 + 1);
    const expired = await fixture.request("/auth/totp/verify", {
      body: { challenge: fourth.body.challenge.token, code: code(secret, fixture.clock()) },
    });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe("AUTH_TOKEN_INVALID");

    const events = fixture.store.auditEvents().map((event) => `${event.event}:${event.outcome}`);
    expect(events).toContain("mfa.enrolled:success");
    expect(events).toContain("mfa.challenged:success");
    expect(events).toContain("mfa.verify:failure");
    expect(events).toContain("mfa.verify:success");
    expect(events).toContain("mfa.recover:success");
    expect(events).toContain("mfa.recover:failure");
  });

  it("counts failed codes toward the lockout and locks the challenge", async () => {
    const fixture = createFixture({
      policies: { lockout: { threshold: 2, windowMs: 60_000, durationMs: 60_000 } },
    });
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    const enrol = await fixture.request("/auth/totp/enrol", {
      token: signedIn.session.token,
      body: { password: PASSWORD },
    });
    await fixture.request("/auth/totp/confirm", {
      token: signedIn.session.token,
      body: { code: code(enrol.body.secret, fixture.clock()) },
    });
    fixture.advance(60_000);
    const challenge = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const bad = { challenge: challenge.body.challenge.token, code: "000000" };
    expect((await fixture.request("/auth/totp/verify", { body: bad })).status).toBe(401);
    expect((await fixture.request("/auth/totp/verify", { body: bad })).status).toBe(423);
    expect((await fixture.request("/auth/totp/verify", { body: bad })).status).toBe(423);
  });

  it("requires enrolment per role: a pending-enrolment session reaches only the enrolment flow", async () => {
    const fixture = createFixture({
      defaultRoles: ["admin"],
      policies: { mfa: { required: (account) => account.roles.includes("admin") } },
    });
    await fixture.start();
    const signedIn = await registerAndSignIn(fixture);
    expect(signedIn.status).toBe("mfa-enrolment-required");
    expect(signedIn.session.mfaState).toBe("pending-enrolment");
    const token = signedIn.session.token;
    expect((await fixture.request("/app/admin", { token })).status).toBe(403);
    expect((await fixture.request("/auth/sessions", { token })).status).toBe(403);
    expect((await fixture.request("/auth/me", { token })).status).toBe(200);
    const enrol = await fixture.request("/auth/totp/enrol", {
      token,
      body: { password: PASSWORD },
    });
    expect(enrol.status).toBe(200);
    const confirm = await fixture.request("/auth/totp/confirm", {
      token,
      body: { code: code(enrol.body.secret, fixture.clock()) },
    });
    expect(confirm.status).toBe(200);
    expect((await fixture.request("/auth/sessions", { token })).status).toBe(200);
    expect((await fixture.request("/app/admin", { token })).status).toBe(200);

    // Per surface: the consumer's resolveActor grants admin only to MFA-verified sessions.
    fixture.advance(60_000);
    const challenge = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    const verified = await fixture.request("/auth/totp/verify", {
      body: {
        challenge: challenge.body.challenge.token,
        code: code(enrol.body.secret, fixture.clock()),
      },
    });
    expect(
      (await fixture.request("/app/admin", { token: verified.body.session.token })).status,
    ).toBe(200);
  });
});

describe("rate limiting through the pre-validation policy", () => {
  it("answers 429 with RateLimit headers after the window budget and never counts direct runs", async () => {
    const fixture = createFixture({ rateLimit: { max: 2, windowMs: 60_000 } });
    await fixture.start();
    const attempt = () =>
      fixture.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } });
    const first = await attempt();
    expect(first.status).toBe(401);
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect((await attempt()).headers.get("ratelimit-remaining")).toBe("0");
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("AUTH_RATE_LIMITED");
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("ratelimit-limit")).toBe("2");
    const other = await fixture.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
      headers: { "x-forwarded-for": "198.51.100.9" },
    });
    expect(other.status).toBe(401);
    fixture.advance(60_001);
    expect((await attempt()).status).toBe(401);
    const direct = await fixture.executor.run("auth.sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(direct).toMatchObject({ ok: false, status: 401 });
  });
});
