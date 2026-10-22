import { describe, expect, it } from "vitest";
import { z } from "zod";
import { publicAccess, systemAccess } from "./access.js";
import { systemActor } from "./actor.js";
import { ApplicationCompilationError, compileApp, defineApp } from "./application.js";
import { createExecutor } from "./executor.js";
import { jsonValueSchema, objectSchema, stringSchema } from "./framework-schema.js";
import type { JobBackend } from "./job.js";
import { adaptedJobDependency, defineJob, jobBackendDependency } from "./job.js";
import {
  collectMailerOwners,
  collectMailers,
  defineMailer,
  isMailAddress,
  isMailer,
  isMailInterceptor,
  isMailLedger,
  isMailProvider,
  MAIL_LEDGER_ID,
  MAIL_PROVIDER_ID,
  mailLedgerDependency,
  mailProviderDependency,
  projectMailers,
  renderMailMessage,
  validateMailPayload,
} from "./mail.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import { valueProvider } from "./provider.js";

const welcomePayload = z.object({ name: z.string().min(1), url: z.string().url() });

function accountsMailer() {
  return defineMailer({
    id: "accounts.mailer",
    from: "Accounts <accounts@example.test>",
    messages: {
      welcome: {
        payload: welcomePayload,
        description: "Sent once after sign-up.",
        sample: { name: "Ada", url: "https://example.test/verify/abc" },
        render: ({ name, url }) => ({
          subject: `Welcome, ${name}`,
          html: `<p>Welcome, ${name}. <a href="${url}">Verify</a></p>`,
          text: `Welcome, ${name}. Verify: ${url}`,
        }),
      },
      passwordReset: {
        payload: z.object({ url: z.string().url() }),
        render: ({ url }) => ({
          subject: "Reset your password",
          html: `<a href="${url}">Reset</a>`,
          text: `Reset: ${url}`,
        }),
      },
    },
  });
}

describe("defineMailer", () => {
  it("freezes a mailer with its message names in declaration order", () => {
    const mailer = accountsMailer();
    expect(mailer.kind).toBe("ship.mailer");
    expect(mailer.id).toBe("accounts.mailer");
    expect(mailer.from).toBe("Accounts <accounts@example.test>");
    expect(mailer.messageNames).toEqual(["welcome", "passwordReset"]);
    expect(Object.isFrozen(mailer)).toBe(true);
    expect(Object.isFrozen(mailer.messages)).toBe(true);
    expect(Object.isFrozen(mailer.messages.welcome)).toBe(true);
    expect(isMailer(mailer)).toBe(true);
    expect(isMailer({ kind: "ship.mailer", id: "x" })).toBe(false);
  });

  it.each([
    ["non-object", undefined, "SHIP_MAILER_DEFINITION_INVALID", undefined],
    ["single-segment id", { id: "accounts", messages: {} }, "SHIP_MAILER_ID_INVALID", "id"],
    ["uppercase id", { id: "Accounts.mailer", messages: {} }, "SHIP_MAILER_ID_INVALID", "id"],
    [
      "bad from",
      { id: "accounts.mailer", from: "not an address", messages: {} },
      "SHIP_MAILER_FROM_INVALID",
      "from",
    ],
    [
      "bad replyTo",
      { id: "accounts.mailer", replyTo: "nope", messages: {} },
      "SHIP_MAILER_REPLY_TO_INVALID",
      "replyTo",
    ],
    [
      "no messages",
      { id: "accounts.mailer", messages: {} },
      "SHIP_MAILER_MESSAGES_EMPTY",
      "messages",
    ],
    [
      "array messages",
      { id: "accounts.mailer", messages: [] },
      "SHIP_MAILER_MESSAGES_EMPTY",
      "messages",
    ],
    [
      "bad message name",
      {
        id: "accounts.mailer",
        messages: { "Welcome-Mail": { payload: welcomePayload, render: () => ({}) } },
      },
      "SHIP_MAILER_MESSAGE_NAME_INVALID",
      "messages.Welcome-Mail",
    ],
    [
      "non-object message",
      { id: "accounts.mailer", messages: { welcome: 3 } },
      "SHIP_MAILER_MESSAGE_PAYLOAD_INVALID",
      "messages.welcome",
    ],
    [
      "missing payload schema",
      { id: "accounts.mailer", messages: { welcome: { payload: {}, render: () => ({}) } } },
      "SHIP_MAILER_MESSAGE_PAYLOAD_INVALID",
      "messages.welcome.payload",
    ],
    [
      "missing render",
      { id: "accounts.mailer", messages: { welcome: { payload: welcomePayload } } },
      "SHIP_MAILER_MESSAGE_RENDER_INVALID",
      "messages.welcome.render",
    ],
    [
      "empty description",
      {
        id: "accounts.mailer",
        messages: { welcome: { payload: welcomePayload, render: () => ({}), description: "" } },
      },
      "SHIP_MAILER_MESSAGE_DESCRIPTION_INVALID",
      "messages.welcome.description",
    ],
  ])("rejects %s", (_name, definition, code, field) => {
    expect(() => (defineMailer as (value: unknown) => unknown)(definition)).toThrowError(
      expect.objectContaining({ name: "InvalidMailerDefinitionError", code, field }),
    );
  });

  it("accepts bare and display-name addresses only", () => {
    expect(isMailAddress("ada@example.test")).toBe(true);
    expect(isMailAddress("Ada Lovelace <ada@example.test>")).toBe(true);
    expect(isMailAddress("ada@example")).toBe(false);
    expect(isMailAddress("<ada@example.test")).toBe(false);
    expect(isMailAddress("ada@example.test, bob@example.test")).toBe(false);
    expect(isMailAddress("")).toBe(false);
    expect(isMailAddress(42)).toBe(false);
  });
});

describe("renderMailMessage", () => {
  it("validates the payload, runs the template and freezes the rendering", async () => {
    const rendered = await renderMailMessage(accountsMailer(), "welcome", {
      name: "Ada",
      url: "https://example.test/verify/abc",
    });
    expect(rendered).toEqual({
      mailerId: "accounts.mailer",
      message: "welcome",
      payload: { name: "Ada", url: "https://example.test/verify/abc" },
      subject: "Welcome, Ada",
      html: '<p>Welcome, Ada. <a href="https://example.test/verify/abc">Verify</a></p>',
      text: "Welcome, Ada. Verify: https://example.test/verify/abc",
    });
    expect(Object.isFrozen(rendered)).toBe(true);
  });

  it("reports unknown messages and invalid payloads with structured issues", async () => {
    const mailer = accountsMailer();
    await expect(renderMailMessage(mailer, "goodbye", {})).rejects.toMatchObject({
      name: "MailRenderError",
      code: "SHIP_MAIL_MESSAGE_UNKNOWN",
      mailerId: "accounts.mailer",
      messageName: "goodbye",
    });
    await expect(validateMailPayload(mailer, "welcome", { name: "" })).rejects.toMatchObject({
      code: "SHIP_MAIL_PAYLOAD_INVALID",
      issues: expect.arrayContaining([expect.objectContaining({ path: ["name"] })]),
    });
  });

  it("rejects templates that throw or return an incomplete rendering", async () => {
    const throwing = defineMailer({
      id: "notes.mailer",
      messages: {
        broken: {
          payload: jsonValueSchema(),
          render: () => {
            throw new Error("template exploded");
          },
        },
        partial: {
          payload: jsonValueSchema(),
          render: () => ({ subject: "x", html: "", text: "t" }),
        },
      },
    });
    await expect(renderMailMessage(throwing, "broken", null)).rejects.toMatchObject({
      code: "SHIP_MAIL_RENDERING_INVALID",
      cause: expect.objectContaining({ message: "template exploded" }),
    });
    await expect(renderMailMessage(throwing, "partial", null)).rejects.toMatchObject({
      code: "SHIP_MAIL_RENDERING_INVALID",
    });
  });
});

describe("mail dependency tokens and contracts", () => {
  it("builds the provider effect token and the ledger token", () => {
    expect(mailProviderDependency()).toMatchObject({
      kind: "ship.dependency",
      id: MAIL_PROVIDER_ID,
      scope: "effect",
      delivery: "immediate",
    });
    expect(mailLedgerDependency()).toEqual({ kind: "ship.dependency", id: MAIL_LEDGER_ID });
  });

  it("recognizes structural providers, ledgers and interceptors", () => {
    expect(
      isMailProvider({ kind: "ship.mail-provider", adapter: "log", send: () => undefined }),
    ).toBe(true);
    expect(isMailProvider({ kind: "ship.mail-provider", adapter: "log" })).toBe(false);
    const ledger = Object.fromEntries(
      ["claim", "markSent", "markFailed", "find", "list", "cleanup"].map((name) => [
        name,
        () => undefined,
      ]),
    );
    expect(isMailLedger({ kind: "ship.mail-ledger", adapter: "memory", ...ledger })).toBe(true);
    expect(isMailLedger({ kind: "ship.mail-ledger", adapter: "memory" })).toBe(false);
    expect(
      isMailInterceptor({
        kind: "ship.mail-interceptor",
        adapter: "allowlist",
        intercept: () => 1,
      }),
    ).toBe(true);
    expect(isMailInterceptor({ kind: "ship.mail-interceptor" })).toBe(false);
  });
});

describe("modules and the application graph", () => {
  it("declares mailers on a module, projects names only and rejects duplicates", () => {
    const mailer = accountsMailer();
    const accounts = defineModule({
      id: "accounts",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      mailers: [mailer],
    });
    expect(accounts.mailers).toEqual([mailer]);
    expect(Object.isFrozen(accounts.mailers)).toBe(true);
    expect(() =>
      defineModule({
        id: "accounts",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        mailers: [mailer, mailer],
      }),
    ).toThrowError(expect.objectContaining({ code: "SHIP_MODULE_MAILER_DUPLICATE" }));
    expect(() =>
      defineModule({
        id: "accounts",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        mailers: [{} as never],
      }),
    ).toThrowError(expect.objectContaining({ code: "SHIP_MODULE_MAILER_INVALID" }));

    const app = defineApp({ id: "mail-fixture", modules: [accounts] });
    expect(app.graph.mailers).toEqual([
      {
        id: "accounts.mailer",
        moduleId: "accounts",
        from: "Accounts <accounts@example.test>",
        messages: ["passwordReset", "welcome"],
      },
    ]);
    expect(app.graph.modules[0]?.mailers).toEqual(["accounts.mailer"]);
    expect(JSON.stringify(app.graph)).not.toContain("render");
    expect(collectMailers(app.modules)).toEqual([mailer]);
    expect(projectMailers(app.modules)).toEqual(app.graph.mailers);
  });

  it("fails compilation for duplicate or mis-namespaced mailer ids", () => {
    const mailer = accountsMailer();
    const first = defineModule({
      id: "accounts",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      mailers: [mailer],
    });
    const foreign = defineMailer({
      id: "notes.mailer",
      messages: {
        ping: {
          payload: jsonValueSchema(),
          render: () => ({ subject: "p", html: "h", text: "t" }),
        },
      },
    });
    const second = defineModule({
      id: "billing",
      operations: [],
      providers: [],
      imports: [],
      exports: [],
      mailers: [mailer, foreign],
    });
    let caught: unknown;
    try {
      compileApp({ id: "dup", modules: [first, second] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplicationCompilationError);
    const codes = (caught as ApplicationCompilationError).diagnostics.map((item) => item.code);
    expect(codes).toContain("SHIP_MAILER_ID_DUPLICATE");
    expect(codes).toContain("SHIP_MAILER_ID_MISMATCH");

    const diagnostics: never[] = [];
    const owners = collectMailerOwners("dup", [first, second], diagnostics);
    expect([...owners.keys()]).toEqual(["accounts.mailer", "notes.mailer"]);
    expect(diagnostics).toHaveLength(2);
  });

  it("compiles a module without mailers to an empty list", () => {
    const app = defineApp({
      id: "plain",
      modules: [
        defineModule({ id: "platform", operations: [], providers: [], imports: [], exports: [] }),
      ],
    });
    expect(app.graph.mailers).toEqual([]);
    expect(app.graph.modules[0]?.mailers).toEqual([]);
  });
});

describe("adaptedJobDependency", () => {
  it("hands the handler the adapted facade while keeping the job edge", async () => {
    const deliver = defineJob({
      id: "mail.deliver",
      input: objectSchema({ to: stringSchema({ minLength: 1 }) }),
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel" },
      retry: { attempts: 1, backoff: { initialMs: 1 } },
      transaction: "none",
      dependencies: {},
      handler: ({ input }) => ({ delivered: input.to }),
    });
    const token = adaptedJobDependency(deliver, (enqueuer) => ({
      kind: "facade" as const,
      send: (to: string) => enqueuer.enqueue({ to }, { dedupeKey: to }),
    }));
    expect(token).toMatchObject({ scope: "job", role: "enqueue", job: deliver });
    expect(() => adaptedJobDependency(deliver, undefined as never)).toThrowError(
      expect.objectContaining({ code: "SHIP_JOB_DEFINITION_INVALID" }),
    );

    const enqueued: unknown[] = [];
    const backend: JobBackend = {
      kind: "ship.job-backend",
      adapter: "test",
      concurrencyBudget: { maxInFlight: 1, maxQueueDepth: 1 },
      attach: () => undefined,
      enqueue: async (jobId, input, options) => {
        enqueued.push([jobId, input, options]);
        return { accepted: true, runId: "run-1", deduplicated: false };
      },
      schedule: async () => undefined,
      unschedule: async () => undefined,
      startWorkers: async () => 0,
      quit: async () => undefined,
      health: async () => ({ jobs: [] }),
      listFailed: async () => [],
      retry: async () => undefined,
      discard: async () => undefined,
      cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
    };
    const send = defineOperation({
      id: "mail.send",
      input: {},
      output: { 200: jsonValueSchema() },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { mail: token },
      handler: async ({ services }) => {
        expect(services.mail.kind).toBe("facade");
        return services.mail.send("ada@example.test");
      },
    });
    const app = defineApp({
      id: "adapted",
      modules: [
        defineModule({
          id: "mail",
          operations: [deliver, send],
          providers: [valueProvider(jobBackendDependency(), backend)],
          imports: [],
          exports: [],
        }),
      ],
    });
    expect(app.graph.jobs[0]?.operations.enqueuedBy).toEqual(["mail.send"]);
    const result = await createExecutor(app).run(
      "mail.send",
      {},
      { actor: systemActor({ id: "t" }) },
    );
    expect(result).toMatchObject({ ok: true, data: { accepted: true, runId: "run-1" } });
    expect(enqueued).toEqual([
      ["mail.deliver", { to: "ada@example.test" }, { dedupeKey: "ada@example.test" }],
    ]);
    expect(systemAccess().kind).toBe("system");
  });
});
