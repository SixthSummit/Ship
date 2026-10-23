import { defineApp, defineMailer, defineModule } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { projectClientContract } from "./project.js";

function application(withMailer: boolean) {
  const mailer = defineMailer({
    id: "accounts.mailer",
    from: "accounts@example.test",
    messages: {
      welcome: {
        payload: z.object({ name: z.string() }),
        render: ({ name }) => ({ subject: `Hi ${name}`, html: "<p>hi</p>", text: "hi" }),
      },
      passwordReset: {
        payload: z.object({ url: z.string() }),
        render: ({ url }) => ({ subject: "Reset", html: `<a href="${url}">r</a>`, text: url }),
      },
    },
  });
  return defineApp({
    id: "mail-contract",
    modules: [
      defineModule({
        id: "accounts",
        operations: [],
        providers: [],
        imports: [],
        exports: [],
        ...(withMailer ? { mailers: [mailer] } : {}),
      }),
    ],
  });
}

describe("projectClientContract mailers", () => {
  it("projects mailer ids and message names only", () => {
    const contract = projectClientContract(application(true));
    expect(contract.mailers).toEqual({
      "accounts.mailer": { messages: ["passwordReset", "welcome"] },
    });
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toContain("accounts@example.test");
    expect(serialized).not.toContain("render");
    expect(serialized).not.toContain("<p>hi</p>");
    expect(Object.isFrozen(contract.mailers)).toBe(true);
  });

  it("omits the field and keeps the fingerprint when no mailer is declared", () => {
    const without = projectClientContract(application(false));
    expect(without.mailers).toBeUndefined();
    expect(without.fingerprint).not.toBe(projectClientContract(application(true)).fingerprint);
  });
});
