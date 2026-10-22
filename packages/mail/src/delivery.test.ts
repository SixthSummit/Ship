import {
  createExecutor,
  defineMailer,
  jsonValueSchema,
  MAIL_ORIGINAL_TO_HEADER,
  operationActor,
  startJobRuntime,
} from "@sixthsummit/ship-core";
import { runJobOnce } from "@sixthsummit/ship-testing/jobs";
import { describe, expect, it, vi } from "vitest";
import { accountsMailer, billingMailer, createFixtureApplication } from "./__fixtures__/app.js";
import {
  DEFAULT_MAIL_RETRY,
  defineMailDelivery,
  type MailDeliveryInput,
  type MailDeliveryOutput,
} from "./delivery.js";
import { allowlistInterceptor } from "./interceptor.js";
import { logMailProvider } from "./log.js";
import { createInMemoryMailLedger } from "./memory-ledger.js";

const sender = operationActor({ id: "ops", permissions: ["accounts:write"] });

function fixture(overrides: Partial<Parameters<typeof createFixtureApplication>[0]> = {}) {
  const provider = logMailProvider();
  const ledger = createInMemoryMailLedger();
  const built = createFixtureApplication({ provider, ledger, ...overrides });
  const executor = createExecutor(built.app);
  return { ...built, provider, ledger, executor };
}

async function attach(app: ReturnType<typeof fixture>["app"], jobs: ReturnType<typeof fixture>["jobs"]) {
  await startJobRuntime(app, { backend: jobs, mode: "api" });
}

describe("defineMailDelivery", () => {
  it("compiles a job on the jobs capability with the provider as its only effect", () => {
    const { app, delivery } = fixture();
    expect(delivery).toMatchObject({ kind: "ship.mail-delivery", id: "mail.deliver" });
    expect(delivery.job.id).toBe("mail.deliver");
    expect(delivery.job.job.retry).toEqual(DEFAULT_MAIL_RETRY);
    const node = app.graph.jobs.find((job) => job.id === "mail.deliver");
    expect(node).toMatchObject({
      moduleId: "mail",
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel", max: 4 },
      transaction: "none",
      effects: ["ship.mail.provider"],
      operations: { enqueuedBy: ["accounts.send-welcome"] },
    });
    expect(app.graph.mailers.map((mailer) => mailer.id)).toEqual(["accounts.mailer", "billing.mailer"]);
    expect(
      app.graph.operations.find((operation) => operation.id === "accounts.send-welcome")?.job,
    ).toEqual([{ role: "enqueue", jobId: "mail.deliver" }]);
  });

  it.each([
    ["non-object", undefined, "options"],
    ["single-segment id", { id: "deliver", mailers: [accountsMailer] }, "id"],
    ["no mailers", { mailers: [] }, "mailers"],
    ["non-mailer entries", { mailers: [{}] }, "mailers"],
    ["duplicate mailers", { mailers: [accountsMailer, accountsMailer] }, "mailers"],
    ["invalid from", { mailers: [accountsMailer], from: "nope" }, "from"],
    ["mailer without from and no default", { mailers: [billingMailer] }, "from"],
    ["bad interceptor", { mailers: [accountsMailer], interceptor: {} }, "interceptor"],
    ["bad maxInFlight", { mailers: [accountsMailer], maxInFlight: 0 }, "maxInFlight"],
    ["bad claimLeaseMs", { mailers: [accountsMailer], claimLeaseMs: -1 }, "claimLeaseMs"],
    ["bad clock", { mailers: [accountsMailer], clock: 3 }, "clock"],
  ])("rejects %s", (_name, options, field) => {
    expect(() => (defineMailDelivery as (value: unknown) => unknown)(options)).toThrowError(
      expect.objectContaining({ code: "SHIP_MAIL_DELIVERY_OPTIONS_INVALID", field }),
    );
  });
});

describe("MailSender", () => {
  it("validates at the call site before enqueueing", async () => {
    const { executor, jobs, app } = fixture();
    await attach(app, jobs);
    const run = (body: Record<string, unknown>) =>
      executor.run("accounts.send-welcome", { body }, { actor: sender });
    // Sender failures are programming errors at the call site, not dead letters.
    await expect(run({ to: "not-an-address", name: "Ada", key: "k" })).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
      cause: expect.objectContaining({ code: "SHIP_MAIL_RECIPIENT_INVALID" }),
    });
    await expect(run({ to: "ada@example.test", name: "", key: "k" })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(run({ to: "ada@example.test", name: "Ada", key: "has space" })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "SHIP_MAIL_IDEMPOTENCY_KEY_INVALID" }),
    });
    expect(jobs.runs()).toEqual([]);
  });

  it("refuses a mailer that is not registered with the delivery", async () => {
    const { delivery } = fixture();
    const other = defineMailer({
      id: "other.mailer",
      from: "o@example.test",
      messages: { ping: { payload: jsonValueSchema(), render: () => ({ subject: "p", html: "h", text: "t" }) } },
    });
    const facade = (delivery.dependency.adapt as (enqueuer: unknown) => { send: (...args: unknown[]) => Promise<unknown> })({
      kind: "ship.job-enqueuer",
      jobId: "mail.deliver",
      enqueue: async () => ({ accepted: true, runId: "r", deduplicated: false }),
    });
    await expect(
      facade.send(other, "ping", { to: "a@example.test", payload: {}, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "SHIP_MAIL_MAILER_UNREGISTERED" });
    await expect(
      facade.send(accountsMailer, "welcome", { to: [], payload: {}, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "SHIP_MAIL_RECIPIENT_INVALID" });
    await expect(
      facade.send(accountsMailer, "welcome", {
        to: "a@example.test",
        payload: { name: "Ada", url: "https://example.test" },
        idempotencyKey: "",
      }),
    ).rejects.toMatchObject({ code: "SHIP_MAIL_IDEMPOTENCY_KEY_INVALID" });
    await expect(
      facade.send(accountsMailer, "welcome", {
        to: "a@example.test",
        payload: { name: "Ada", url: "not a url" },
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ name: "MailRenderError", code: "SHIP_MAIL_PAYLOAD_INVALID" });
  });

  it("enqueues one validated run per idempotency key and deduplicates live sends", async () => {
    const { executor, jobs, app } = fixture();
    await attach(app, jobs);
    const first = await executor.run(
      "accounts.send-welcome",
      { body: { to: "ada@example.test", name: "Ada", key: "welcome:ada", tenantId: "acme" } },
      { actor: sender },
    );
    const second = await executor.run(
      "accounts.send-welcome",
      { body: { to: "ada@example.test", name: "Ada", key: "welcome:ada" } },
      { actor: sender },
    );
    expect(first).toMatchObject({ ok: true, data: { accepted: true, deduplicated: false } });
    expect(second).toMatchObject({ ok: true, data: { accepted: true, deduplicated: true } });
    expect(jobs.runs()).toHaveLength(1);
    expect(jobs.runs()[0]).toMatchObject({
      jobId: "mail.deliver",
      dedupeKey: "welcome:ada",
      input: {
        mailerId: "accounts.mailer",
        message: "welcome",
        to: ["ada@example.test"],
        payload: { name: "Ada", url: "https://example.test/verify/abc" },
        idempotencyKey: "welcome:ada",
        tenantId: "acme",
      },
    });
  });

  it("reports queue-full as a result rather than an exception", async () => {
    const { createInMemoryJobBackend } = await import("@sixthsummit/ship-testing/jobs");
    const jobs = createInMemoryJobBackend({ maxQueueDepth: 1 });
    const { executor, app } = fixture({ jobs });
    await attach(app, jobs);
    const body = (key: string) => ({ body: { to: "ada@example.test", name: "Ada", key } });
    await executor.run("accounts.send-welcome", body("a"), { actor: sender });
    await expect(
      executor.run("accounts.send-welcome", body("b"), { actor: sender }),
    ).resolves.toMatchObject({ ok: true, data: { accepted: false, rejected: "queue-full" } });
  });
});

describe("mail.deliver", () => {
  const input = (overrides: Partial<MailDeliveryInput> = {}): MailDeliveryInput => ({
    mailerId: "accounts.mailer",
    message: "welcome",
    to: ["ada@example.test"],
    payload: { name: "Ada", url: "https://example.test/verify/abc" },
    idempotencyKey: "welcome:ada",
    ...overrides,
  });

  it("renders, claims the ledger, calls the provider once and records the outcome", async () => {
    const clock = vi.fn(() => new Date("2026-10-22T10:00:00.000Z"));
    const { app, provider, ledger, executor, jobs } = fixture({ delivery: { clock } });
    await attach(app, jobs);
    await executor.run(
      "accounts.send-welcome",
      { body: { to: "ada@example.test", name: "Ada", key: "welcome:ada" } },
      { actor: sender },
    );
    const drained = await jobs.drain();
    expect(drained).toEqual({ executed: 1, completed: 1, failed: 0 });
    expect(provider.sent()).toHaveLength(1);
    expect(provider.sent()[0]).toMatchObject({
      idempotencyKey: "welcome:ada",
      mailerId: "accounts.mailer",
      message: "welcome",
      envelope: {
        from: "Accounts <accounts@example.test>",
        to: ["ada@example.test"],
        replyTo: "support@example.test",
        subject: "Welcome, Ada",
        text: "Welcome, Ada. Verify: https://example.test/verify/abc",
      },
    });
    expect(ledger.records()).toEqual([
      expect.objectContaining({
        idempotencyKey: "welcome:ada",
        status: "sent",
        attempts: 1,
        provider: "log",
        providerMessageId: "log-1",
        to: ["ada@example.test"],
        deliveredTo: ["ada@example.test"],
        intercepted: false,
        subject: "Welcome, Ada",
        sentAt: new Date("2026-10-22T10:00:00.000Z"),
      }),
    ]);
  });

  it("never calls the provider twice for one idempotency key, even when the run is replayed", async () => {
    const { app, provider, ledger, executor } = fixture();
    const first = await runJobOnce(app, "mail.deliver", input(), { executor });
    const again = await runJobOnce(app, "mail.deliver", input(), { executor });
    const third = await runJobOnce(app, "mail.deliver", input({ to: ["someone-else@example.test"] }), {
      executor,
    });
    expect(first).toMatchObject({ ok: true, data: { status: "sent", attempt: 1, providerMessageId: "log-1" } });
    expect(again).toMatchObject({ ok: true, data: { status: "duplicate", attempt: 1, providerMessageId: "log-1" } });
    expect(third).toMatchObject({ ok: true, data: { status: "duplicate" } });
    expect(provider.sent()).toHaveLength(1);
    expect(ledger.records()).toHaveLength(1);
  });

  it("uses the delivery default from, the input replyTo, cc, bcc and headers", async () => {
    const { app, provider, executor } = fixture();
    await runJobOnce(
      app,
      "mail.deliver",
      input({
        mailerId: "billing.mailer",
        message: "invoice",
        payload: { amount: 10, currency: "USD" },
        idempotencyKey: "invoice:1",
        cc: ["finance@example.test"],
        bcc: ["audit@example.test"],
        replyTo: "billing@example.test",
        headers: { "X-Entity-Ref": "inv-1" },
      }),
      { executor },
    );
    expect(provider.sent()[0]?.envelope).toEqual({
      from: "Ship <ship@example.test>",
      to: ["ada@example.test"],
      cc: ["finance@example.test"],
      bcc: ["audit@example.test"],
      replyTo: "billing@example.test",
      subject: "Invoice 10 USD",
      html: "<p>10 USD</p>",
      text: "10 USD",
      headers: { "X-Entity-Ref": "inv-1" },
    });
  });

  it("retries a retryable provider failure and dead-letters a final rejection", async () => {
    let outcomes: ("retry" | "reject" | "ok")[] = ["retry", "ok"];
    const provider = logMailProvider({
      outcome: () => {
        const next = outcomes.shift() ?? "ok";
        if (next === "retry") return { accepted: false, retryable: true, error: "429 slow down" };
        if (next === "reject") return { accepted: false, retryable: false, error: "invalid from" };
        return { accepted: true };
      },
    });
    const { createInMemoryJobBackend } = await import("@sixthsummit/ship-testing/jobs");
    const jobs = createInMemoryJobBackend({ clock: () => new Date(Date.now() + 10 * 60_000) });
    const ledger = createInMemoryMailLedger();
    const { app } = createFixtureApplication({
      provider,
      ledger,
      jobs,
      delivery: { retry: { attempts: 3, backoff: { initialMs: 0 } } },
    });
    await attach(app, jobs);
    await jobs.enqueue("mail.deliver", input());
    const drained = await jobs.drain();
    expect(drained).toEqual({ executed: 2, completed: 1, failed: 0 });
    expect(provider.sent()).toHaveLength(1);
    expect(ledger.records()[0]).toMatchObject({ status: "sent", attempts: 2 });
    expect(jobs.runs()[0]).toMatchObject({
      status: "completed",
      attempts: 2,
      history: [expect.objectContaining({ error: expect.stringContaining("429 slow down") })],
    });

    outcomes = ["reject"];
    await jobs.enqueue("mail.deliver", input({ idempotencyKey: "welcome:bob", to: ["bob@example.test"] }));
    const rejected = await jobs.drain();
    expect(rejected).toEqual({ executed: 1, completed: 0, failed: 1 });
    expect(jobs.runs()[1]).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: expect.stringContaining("MAIL_REJECTED"),
    });
    expect(ledger.records()[1]).toMatchObject({
      idempotencyKey: "welcome:bob",
      status: "failed",
      lastError: "invalid from",
    });
    expect(provider.sent()).toHaveLength(1);
  });

  it("treats an unknown message or an invalid stored payload as a final declared failure", async () => {
    const { app, provider, executor, ledger } = fixture();
    await expect(
      runJobOnce(app, "mail.deliver", input({ message: "goodbye" }), { executor }),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "MAIL_MESSAGE_UNKNOWN", details: { mailerId: "accounts.mailer", message: "goodbye" } },
    });
    await expect(
      runJobOnce(app, "mail.deliver", input({ mailerId: "nobody.mailer" }), { executor }),
    ).resolves.toMatchObject({ ok: false, error: { code: "MAIL_MESSAGE_UNKNOWN" } });
    await expect(
      runJobOnce(app, "mail.deliver", input({ payload: { name: "" } }), { executor }),
    ).resolves.toMatchObject({ ok: false, status: 422, error: { code: "MAIL_PAYLOAD_INVALID" } });
    expect(provider.sent()).toHaveLength(0);
    expect(ledger.records()).toHaveLength(0);
  });

  it("backs off while another run holds the claim", async () => {
    const { app, provider, executor, ledger } = fixture();
    await ledger.claim({
      idempotencyKey: "welcome:ada",
      mailerId: "accounts.mailer",
      message: "welcome",
      to: ["ada@example.test"],
      deliveredTo: ["ada@example.test"],
      intercepted: false,
      subject: "Welcome, Ada",
      provider: "log",
      now: new Date(),
      leaseMs: 60_000,
    });
    await expect(runJobOnce(app, "mail.deliver", input(), { executor })).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
      cause: expect.objectContaining({ code: "SHIP_MAIL_SEND_IN_FLIGHT", idempotencyKey: "welcome:ada" }),
    });
    expect(provider.sent()).toHaveLength(0);
  });

  it("delivers to the allowlist inbox in non-production and records both recipients", async () => {
    const interceptor = allowlistInterceptor({
      allow: ["@example.test"],
      redirectTo: ["inbox@example.test"],
    });
    const { app, provider, executor, ledger } = fixture({ interceptor });
    const result = await runJobOnce(
      app,
      "mail.deliver",
      input({ to: ["customer@real-customer.example"], idempotencyKey: "welcome:customer" }),
      { executor },
    );
    expect(result).toMatchObject({ ok: true, data: { status: "sent", intercepted: true } });
    expect(provider.sent()[0]?.envelope).toMatchObject({
      to: ["inbox@example.test"],
      subject: "[to: customer@real-customer.example] Welcome, Ada",
      headers: { [MAIL_ORIGINAL_TO_HEADER]: "customer@real-customer.example" },
    });
    expect(ledger.records()[0]).toMatchObject({
      to: ["customer@real-customer.example"],
      deliveredTo: ["inbox@example.test"],
      intercepted: true,
    });
    expect(await ledger.list({ recipient: "customer@real-customer.example", limit: 5 })).toHaveLength(1);
    const output = (result as { data: MailDeliveryOutput }).data;
    expect(output.idempotencyKey).toBe("welcome:customer");
  });
});
