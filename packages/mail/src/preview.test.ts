import { createExecutor, operationActor, permission, publicAccess } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { accountsMailer, createFixtureApplication } from "./__fixtures__/app.js";
import { logMailProvider } from "./log.js";
import { createInMemoryMailLedger } from "./memory-ledger.js";
import { defineMailPreview, MAIL_PREVIEW_PERMISSION } from "./preview.js";

const viewer = operationActor({ id: "dev", permissions: [MAIL_PREVIEW_PERMISSION] });

describe("defineMailPreview", () => {
  it("lists every mailer and message and renders a message from its sample", async () => {
    const { app } = createFixtureApplication({
      provider: logMailProvider(),
      ledger: createInMemoryMailLedger(),
    });
    const executor = createExecutor(app);
    const list = await executor.run("mail.preview-list", {}, { actor: viewer });
    expect(list).toMatchObject({
      ok: true,
      data: {
        mailers: [
          {
            id: "accounts.mailer",
            from: "Accounts <accounts@example.test>",
            messages: [
              { name: "welcome", description: "Sent once after sign-up.", hasSample: true },
              { name: "passwordReset", hasSample: false },
            ],
          },
          { id: "billing.mailer", messages: [{ name: "invoice", hasSample: true }] },
        ],
      },
    });
    const rendered = await executor.run(
      "mail.preview-render",
      { params: { mailerId: "accounts.mailer", message: "welcome" } },
      { actor: viewer },
    );
    expect(rendered).toMatchObject({
      ok: true,
      data: {
        mailerId: "accounts.mailer",
        message: "welcome",
        subject: "Welcome, Ada",
        html: '<p>Welcome, Ada. <a href="https://example.test/verify/sample">Verify</a></p>',
        text: "Welcome, Ada. Verify: https://example.test/verify/sample",
        payload: { name: "Ada", url: "https://example.test/verify/sample" },
      },
    });
  });

  it("fails with declared errors for unknown messages and missing or invalid samples", async () => {
    const broken = {
      ...accountsMailer,
      id: "accounts.broken",
      messages: {
        ...accountsMailer.messages,
        welcome: { ...accountsMailer.messages.welcome, sample: { name: "" } },
      },
    };
    const preview = defineMailPreview({
      mailers: [accountsMailer, broken as never],
      prefix: "dev",
    });
    const { defineApp, defineModule } = await import("@sixthsummit/ship-core");
    const app = defineApp({
      id: "preview",
      modules: [
        defineModule({
          id: "dev",
          operations: [...preview.operations],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const executor = createExecutor(app);
    const render = (mailerId: string, message: string) =>
      executor.run("dev.preview-render", { params: { mailerId, message } }, { actor: viewer });
    await expect(render("accounts.mailer", "nope")).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: "MAIL_PREVIEW_NOT_FOUND" },
    });
    await expect(render("accounts.mailer", "passwordReset")).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "MAIL_PREVIEW_SAMPLE_MISSING" },
    });
    await expect(render("accounts.broken", "welcome")).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: { code: "MAIL_PREVIEW_SAMPLE_INVALID" },
    });
    // Previews are permission-gated, never anonymous.
    await expect(
      executor.run("dev.preview-list", {}, { actor: operationActor({ id: "guest" }) }),
    ).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("accepts a custom non-public access and transport and rejects bad options", () => {
    const preview = defineMailPreview({
      mailers: [accountsMailer],
      access: permission("ops:mail"),
      transport: { list: { kind: "http", binding: "GET /dev/mail" } },
    });
    expect(preview.list.access).toEqual(permission("ops:mail"));
    expect(preview.list.transport).toMatchObject({ kind: "http" });
    expect(preview.render.transport).toBeUndefined();
    expect(() =>
      defineMailPreview({ mailers: [accountsMailer], access: publicAccess() }),
    ).toThrowError(
      expect.objectContaining({ code: "SHIP_MAIL_PREVIEW_OPTIONS_INVALID", field: "access" }),
    );
    expect(() => defineMailPreview({ mailers: [{}] as never })).toThrowError(
      expect.objectContaining({ field: "mailers" }),
    );
    expect(() => defineMailPreview({ mailers: [], prefix: "Bad.Prefix" })).toThrowError(
      expect.objectContaining({ field: "prefix" }),
    );
    expect(() => (defineMailPreview as (value: unknown) => unknown)(null)).toThrowError(
      expect.objectContaining({ field: "options" }),
    );
  });
});
