import { createExecutor, operationActor, startJobRuntime } from "@sixthsummit/ship-core";
import { createDrizzleMailLedger, shipMailSendsTable } from "@sixthsummit/ship-drizzle";
import { createInMemoryJobBackend, runJobOnce } from "@sixthsummit/ship-testing/jobs";
import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixtureApplication } from "./__fixtures__/app.js";
import { mailLedgerConformance } from "./conformance.js";
import { allowlistInterceptor } from "./interceptor.js";
import { logMailProvider } from "./log.js";

const mailSends = shipMailSendsTable();
const schema = { mailSends };

let context: PostgresTestDb<typeof schema>;

beforeAll(async () => {
  context = await setupPostgresTestDb(schema);
}, 120_000);

afterAll(async () => {
  await context?.cleanup();
}, 60_000);

async function truncate() {
  await context.pool.query(`TRUNCATE TABLE "ship_mail_sends"`);
}

mailLedgerConformance(
  "drizzle",
  async () => {
    await truncate();
    return createDrizzleMailLedger({ database: context.db, table: mailSends });
  },
  { describe, it, beforeEach, afterEach, expect },
);

describe("mail delivery against PostgreSQL", () => {
  const sender = operationActor({ id: "ops", permissions: ["accounts:write"] });

  beforeEach(truncate);

  it("enqueues from an operation, delivers once and answers a replay from the ledger", async () => {
    const provider = logMailProvider();
    const ledger = createDrizzleMailLedger({ database: context.db, table: mailSends });
    const jobs = createInMemoryJobBackend();
    const { app } = createFixtureApplication({ provider, ledger, jobs });
    await startJobRuntime(app, { backend: jobs, mode: "api" });
    const executor = createExecutor(app);

    const body = { to: "ada@example.test", name: "Ada", key: "welcome:ada", tenantId: "acme" };
    const first = await executor.run("accounts.send-welcome", { body }, { actor: sender });
    const dedup = await executor.run("accounts.send-welcome", { body }, { actor: sender });
    expect(first).toMatchObject({ ok: true, data: { accepted: true, deduplicated: false } });
    expect(dedup).toMatchObject({ ok: true, data: { accepted: true, deduplicated: true } });

    await expect(jobs.drain()).resolves.toEqual({ executed: 1, completed: 1, failed: 0 });

    // A redelivered run (at-least-once) and a brand-new run with the same key both
    // settle from the ledger without a second provider call.
    const run = jobs.runs()[0];
    const replay = await runJobOnce(app, "mail.deliver", run?.input, { executor });
    expect(replay).toMatchObject({ ok: true, data: { status: "duplicate", attempt: 1 } });
    await executor.run("accounts.send-welcome", { body }, { actor: sender });
    await expect(jobs.drain()).resolves.toEqual({ executed: 1, completed: 1, failed: 0 });

    expect(provider.sent()).toHaveLength(1);
    const rows = await context.db.select().from(mailSends);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idempotencyKey: "welcome:ada",
      mailerId: "accounts.mailer",
      message: "welcome",
      recipients: ["ada@example.test"],
      deliveredTo: ["ada@example.test"],
      intercepted: false,
      status: "sent",
      attempts: 1,
      provider: "log",
      providerMessageId: "log-1",
      tenantId: "acme",
    });
    expect(rows[0]?.sentAt).toBeInstanceOf(Date);
    await expect(ledger.list({ recipient: "ada@example.test", limit: 10 })).resolves.toHaveLength(
      1,
    );
    await expect(
      ledger.list({ tenantId: "acme", mailerId: "accounts.mailer", limit: 10 }),
    ).resolves.toHaveLength(1);
    await expect(ledger.list({ recipient: "bob@example.test", limit: 10 })).resolves.toHaveLength(
      0,
    );
  });

  it("records the redirected delivery while keeping the original recipient queryable", async () => {
    const provider = logMailProvider();
    const ledger = createDrizzleMailLedger({ database: context.db, table: mailSends });
    const { app } = createFixtureApplication({
      provider,
      ledger,
      interceptor: allowlistInterceptor({
        allow: ["@example.test"],
        redirectTo: ["inbox@example.test"],
      }),
    });
    const executor = createExecutor(app);
    const result = await runJobOnce(
      app,
      "mail.deliver",
      {
        mailerId: "accounts.mailer",
        message: "welcome",
        to: ["customer@real-customer.example"],
        payload: { name: "Ada", url: "https://example.test/verify/abc" },
        idempotencyKey: "welcome:customer",
      },
      { executor },
    );
    expect(result).toMatchObject({ ok: true, data: { status: "sent", intercepted: true } });
    expect(provider.sent()[0]?.envelope.to).toEqual(["inbox@example.test"]);
    const [row] = await ledger.list({ recipient: "customer@real-customer.example", limit: 1 });
    expect(row).toMatchObject({
      to: ["customer@real-customer.example"],
      deliveredTo: ["inbox@example.test"],
      intercepted: true,
      status: "sent",
    });
  });

  it("serializes concurrent claims on one key so only one run reaches the provider", async () => {
    const ledger = createDrizzleMailLedger({ database: context.db, table: mailSends });
    const claim = {
      idempotencyKey: "race",
      mailerId: "accounts.mailer",
      message: "welcome",
      to: ["ada@example.test"],
      deliveredTo: ["ada@example.test"],
      intercepted: false,
      subject: "Welcome",
      provider: "log",
      now: new Date(),
      leaseMs: 60_000,
    };
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => ledger.claim(claim)));
    expect(outcomes.filter((outcome) => outcome.outcome === "claimed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === "in-flight")).toHaveLength(7);
  });
});
