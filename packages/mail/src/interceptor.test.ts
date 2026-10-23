import { MAIL_ORIGINAL_TO_HEADER, type MailEnvelope } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { allowlistInterceptor } from "./interceptor.js";

const envelope: MailEnvelope = Object.freeze({
  from: "Ship <ship@example.test>",
  to: ["customer@real-customer.example", "QA <qa@example.test>"],
  cc: ["manager@real-customer.example", "lead@example.test"],
  bcc: ["audit@real-customer.example"],
  subject: "Your report",
  html: "<p>r</p>",
  text: "r",
  headers: { "X-Entity-Ref": "1" },
});

describe("allowlistInterceptor", () => {
  it("redirects non-allowlisted recipients and preserves the originals in a header", () => {
    const interceptor = allowlistInterceptor({
      allow: ["@example.test"],
      redirectTo: ["inbox@example.test"],
    });
    const result = interceptor.intercept(envelope);
    expect(result.intercepted).toBe(true);
    const { bcc: _bcc, ...withoutBcc } = envelope;
    expect(result.envelope).toEqual({
      ...withoutBcc,
      to: ["QA <qa@example.test>", "inbox@example.test"],
      cc: ["lead@example.test"],
      subject: "[to: customer@real-customer.example, QA <qa@example.test>] Your report",
      headers: {
        "X-Entity-Ref": "1",
        [MAIL_ORIGINAL_TO_HEADER]:
          "customer@real-customer.example, QA <qa@example.test>, cc:manager@real-customer.example, cc:lead@example.test, bcc:audit@real-customer.example",
      },
    });
    expect(result.envelope.bcc).toBeUndefined();
    expect(Object.isFrozen(result.envelope)).toBe(true);
  });

  it("passes an envelope through untouched when every recipient is allowed", () => {
    const interceptor = allowlistInterceptor({
      allow: ["QA@example.test", "lead@example.test", "@real-customer.example"],
      redirectTo: ["inbox@example.test"],
      subjectPrefix: false,
    });
    const result = interceptor.intercept(envelope);
    expect(result).toEqual({ envelope, intercepted: false });
  });

  it("can keep the subject while still redirecting", () => {
    const interceptor = allowlistInterceptor({
      allow: [],
      redirectTo: ["a@example.test", "b@example.test"],
      subjectPrefix: false,
    });
    const result = interceptor.intercept({ ...envelope, cc: undefined, bcc: undefined });
    expect(result.envelope.subject).toBe("Your report");
    expect(result.envelope.to).toEqual(["a@example.test", "b@example.test"]);
    expect(result.envelope.cc).toBeUndefined();
  });

  it.each([
    ["non-object", undefined, "options"],
    ["bad allow entry", { allow: ["not-an-address"], redirectTo: ["a@example.test"] }, "allow"],
    ["bad domain entry", { allow: ["@nodot"], redirectTo: ["a@example.test"] }, "allow"],
    ["empty redirect", { allow: [], redirectTo: [] }, "redirectTo"],
    ["bad redirect", { allow: [], redirectTo: ["x"] }, "redirectTo"],
    [
      "bad prefix flag",
      { allow: [], redirectTo: ["a@example.test"], subjectPrefix: 1 },
      "subjectPrefix",
    ],
  ])("rejects %s", (_name, options, field) => {
    expect(() => (allowlistInterceptor as (value: unknown) => unknown)(options)).toThrowError(
      expect.objectContaining({ code: "SHIP_MAIL_INTERCEPTOR_INVALID", field }),
    );
  });
});
