import { CONSOLE_OPERATE_PERMISSION, defineConsoleModule } from "@sixthsummit/ship-console";
import {
  createExecutor,
  defineActorResolver,
  defineApp,
  defineModule,
  JOBS_MANAGE_PERMISSION,
  operationActor,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, defineHonoCredentialAdapter } from "@sixthsummit/ship-hono";
import { describe, expect, it } from "vitest";
import { createFixture, EMAIL, PASSWORD, registerAndSignIn } from "./__fixtures__/app.js";
import { credentialAuthConsoleExtension } from "./console.js";

const operator = operationActor({ id: "sre", permissions: [CONSOLE_OPERATE_PERMISSION] });
const admin = operationActor({ id: "admin", permissions: [JOBS_MANAGE_PERMISSION] });

function consoleFixture() {
  const fixture = createFixture({
    policies: { lockout: { threshold: 2, windowMs: 60_000, durationMs: 60_000 } },
  });
  const extension = credentialAuthConsoleExtension({ clock: fixture.clock });
  const consoleModule = defineConsoleModule({
    imports: ["auth"],
    extensions: [extension],
    clock: fixture.clock,
  });
  const dummy = defineModule({
    id: "nothing",
    operations: [],
    providers: [],
    imports: [],
    exports: [],
  });
  const app = defineApp({
    id: "auth-console-fixture",
    modules: [...fixture.app.modules.map((module) => module), consoleModule, dummy],
    runtime: { workers: { mode: "api" } },
  });
  return { ...fixture, consoleModule, consoleApp: app, consoleExecutor: createExecutor(app) };
}

describe("credentialAuthConsoleExtension", () => {
  it("mounts as a console panel namespaced by the console id and gated by console.operate only", async () => {
    const { consoleModule, consoleApp, consoleExecutor } = consoleFixture();
    expect(consoleApp.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(consoleModule.panels.map((panel) => panel.id)).toEqual(["auth-audit"]);
    const ids = consoleModule.operations.map((operation) => operation.id);
    expect(ids).toEqual([
      "console.panels",
      "console.auth-audit.events",
      "console.auth-audit.account",
      "console.auth-audit.revoke",
      "console.auth-audit.unlock",
      "console.auth-audit.status",
    ]);
    for (const id of ids) {
      const refused = await consoleExecutor.run(id as never, {} as never, { actor: admin });
      expect(refused, id).toMatchObject({ ok: false, status: 403 });
    }
    expect(
      () =>
        credentialAuthConsoleExtension({ consoleId: "ops", extensionId: "security" }).operations[0]
          .id,
    ).not.toThrow();
    expect(credentialAuthConsoleExtension({ consoleId: "ops" }).operations[0].id).toBe(
      "ops.auth-audit.events",
    );
  });

  it("reads the audit log, inspects an account, unlocks it, revokes sessions and disables it", async () => {
    const harness = consoleFixture();
    await harness.start();
    const signedIn = await registerAndSignIn(harness);
    await harness.request("/auth/sign-in", { body: { email: EMAIL, password: "wrong" } });
    await harness.request("/auth/sign-in", { body: { email: EMAIL, password: "wrong" } });
    const run = <TInput>(id: string, input: TInput) =>
      harness.consoleExecutor.run(id as never, input as never, {
        actor: operator,
        requestId: "console-req",
      });

    const events = await run("console.auth-audit.events", {
      query: { email: EMAIL, event: "sign-in", outcome: "failure" },
    });
    expect(events).toMatchObject({ ok: true });
    const list = (events as { data: { events: { event: string; details?: { reason: string } }[] } })
      .data.events;
    expect(list.map((event) => event.event)).toEqual(["sign-in"]);
    expect(list[0]?.details).toMatchObject({ reason: "wrong-password" });
    const locked = await run("console.auth-audit.events", {
      query: { event: "sign-in.locked", limit: 5 },
    });
    expect((locked as { data: { events: unknown[] } }).data.events).toHaveLength(1);
    const unknown = await run("console.auth-audit.events", {
      query: { email: "nobody@example.test" },
    });
    expect(unknown).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "AUTH_AUDIT_ACCOUNT_NOT_FOUND" },
    });

    const account = await run("console.auth-audit.account", {
      query: { accountId: signedIn.account.id },
    });
    expect(account).toMatchObject({
      ok: true,
      data: {
        account: { email: EMAIL, mfaEnabled: false },
        locked: true,
        sessions: [{ id: signedIn.session.id, current: false }],
        recoveryCodes: { remaining: 0, used: 0 },
      },
    });

    expect(
      (await harness.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(423);
    await run("console.auth-audit.unlock", { body: { accountId: signedIn.account.id } });
    expect(
      (await harness.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(200);

    const revoked = await run("console.auth-audit.revoke", {
      body: { accountId: signedIn.account.id, sessionId: signedIn.session.id },
    });
    expect(revoked).toMatchObject({ ok: true, data: { revoked: 1 } });
    expect((await harness.request("/auth/me", { token: signedIn.session.token })).status).toBe(401);
    const again = await run("console.auth-audit.revoke", {
      body: { accountId: signedIn.account.id, sessionId: signedIn.session.id },
    });
    expect(again).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "AUTH_SESSION_NOT_FOUND" },
    });
    const all = await run("console.auth-audit.revoke", {
      body: { accountId: signedIn.account.id },
    });
    expect(all).toMatchObject({ ok: true, data: { revoked: 1 } });

    const disabled = await run("console.auth-audit.status", {
      body: { accountId: signedIn.account.id, status: "disabled" },
    });
    expect(disabled).toMatchObject({ ok: true, data: { status: "disabled", sessionsRevoked: 0 } });
    const refused = await harness.request("/auth/sign-in", {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(refused.body.error.code).toBe("AUTH_ACCOUNT_DISABLED");
    await run("console.auth-audit.status", {
      body: { accountId: signedIn.account.id, status: "active" },
    });
    expect(
      (await harness.request("/auth/sign-in", { body: { email: EMAIL, password: PASSWORD } }))
        .status,
    ).toBe(200);

    const operatorEvents = harness.store
      .auditEvents()
      .filter((event) => event.event.startsWith("console."))
      .map((event) => [event.event, event.details?.operator]);
    expect(operatorEvents).toEqual([
      ["console.unlocked", "sre"],
      ["console.session-revoked", "sre"],
      ["console.sessions-revoked-all", "sre"],
      ["console.disabled", "sre"],
      ["console.enabled", "sre"],
    ]);
  });

  it("serves the panel over HTTP under the console base path", async () => {
    const harness = consoleFixture();
    await harness.start();
    await registerAndSignIn(harness);
    const http = createHonoAdapter(harness.consoleApp, {
      auth: {
        credentials: defineHonoCredentialAdapter({
          id: "http.token",
          extract: (request) => request.headers.get("x-operator") ?? undefined,
        }),
        actors: defineActorResolver<string>({
          id: "auth.token",
          resolve: ({ credential }) =>
            credential === "sre"
              ? { ok: true, actor: operator }
              : credential === "admin"
                ? { ok: true, actor: admin }
                : { ok: true },
        }),
      },
    });
    expect((await http.request("/console/auth-audit/events")).status).toBe(401);
    expect(
      (await http.request("/console/auth-audit/events", { headers: { "x-operator": "admin" } }))
        .status,
    ).toBe(403);
    const ok = await http.request("/console/auth-audit/events?limit=2", {
      headers: { "x-operator": "sre" },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { events: { event: string }[] };
    expect(body.events.map((event) => event.event)).toEqual(["sign-in", "email.verify"]);
  });
});
