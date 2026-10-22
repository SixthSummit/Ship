import type { MailSendRequest } from "@sixthsummit/ship-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conformanceRequest, mailLedgerConformance, mailProviderConformance } from "./conformance.js";
import { logMailProvider } from "./log.js";
import { createInMemoryMailLedger } from "./memory-ledger.js";
import { RESEND_API_URL, resendMailProvider } from "./resend.js";

const api = { describe, it, beforeEach, afterEach, expect };

mailProviderConformance(
  "log",
  () => {
    const provider = logMailProvider();
    return { provider, forwarded: () => provider.sent() };
  },
  api,
);

interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeResend(answer: (request: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const request = { url: String(input), headers, body: JSON.parse(String(init?.body)) };
    requests.push(request);
    return answer(request);
  };
  return { requests, fetch: fetchImplementation };
}

function toSendRequest(recorded: RecordedRequest): MailSendRequest {
  const body = recorded.body as Record<string, unknown>;
  return {
    idempotencyKey: recorded.headers["idempotency-key"] as string,
    mailerId: "conformance.mailer",
    message: "ping",
    envelope: {
      from: body.from as string,
      to: body.to as string[],
      ...(body.cc ? { cc: body.cc as string[] } : {}),
      ...(body.bcc ? { bcc: body.bcc as string[] } : {}),
      ...(body.reply_to ? { replyTo: body.reply_to as string } : {}),
      subject: body.subject as string,
      html: body.html as string,
      text: body.text as string,
      ...(body.headers ? { headers: body.headers as Record<string, string> } : {}),
    },
  };
}

mailProviderConformance(
  "resend",
  () => {
    const transport = fakeResend(() => Response.json({ id: "re_123" }, { status: 200 }));
    const provider = resendMailProvider({ apiKey: "re_test_key", fetch: transport.fetch });
    return { provider, forwarded: () => transport.requests.map(toSendRequest) };
  },
  api,
);

mailLedgerConformance("memory", () => createInMemoryMailLedger(), api);

describe("resendMailProvider", () => {
  it("posts to /emails with the bearer key and the idempotency key header", async () => {
    const transport = fakeResend(() => Response.json({ id: "re_1" }));
    const provider = resendMailProvider({ apiKey: "re_secret", fetch: transport.fetch });
    const outcome = await provider.send(conformanceRequest({ idempotencyKey: "welcome:1" }));
    expect(outcome).toEqual({ accepted: true, providerMessageId: "re_1" });
    expect(transport.requests[0]).toMatchObject({
      url: `${RESEND_API_URL}/emails`,
      headers: {
        authorization: "Bearer re_secret",
        "content-type": "application/json",
        "idempotency-key": "welcome:1",
      },
      body: {
        from: "Conformance <conformance@example.test>",
        to: ["ada@example.test", "Bob <bob@example.test>"],
        cc: ["cc@example.test"],
        reply_to: "support@example.test",
        subject: "Conformance message",
        headers: { "X-Ship-Original-To": "customer@example.test" },
      },
    });
    expect(transport.requests[0]?.body).not.toHaveProperty("bcc");
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [403, false],
    [422, false],
  ])("maps HTTP %s to retryable=%s and never echoes the key", async (status, retryable) => {
    const transport = fakeResend(() => Response.json({ message: "nope", name: "validation_error" }, { status }));
    const provider = resendMailProvider({ apiKey: "re_secret", fetch: transport.fetch });
    const outcome = await provider.send(conformanceRequest());
    expect(outcome).toEqual({ accepted: false, retryable, error: "nope", status });
    expect(JSON.stringify(outcome)).not.toContain("re_secret");
  });

  it("treats network failures, non-JSON bodies and timeouts as retryable", async () => {
    const failing = resendMailProvider({
      apiKey: "k",
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(failing.send(conformanceRequest())).resolves.toEqual({
      accepted: false,
      retryable: true,
      error: "resend request failed: socket hang up",
    });
    const html = resendMailProvider({
      apiKey: "k",
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    await expect(html.send(conformanceRequest())).resolves.toEqual({
      accepted: false,
      retryable: true,
      error: "resend answered 502",
      status: 502,
    });
    const slow = resendMailProvider({
      apiKey: "k",
      timeoutMs: 5,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(slow.send(conformanceRequest())).resolves.toEqual({
      accepted: false,
      retryable: true,
      error: "resend request timed out after 5 ms",
    });
    const accepted = resendMailProvider({ apiKey: "k", fetch: async () => new Response("ok", { status: 200 }) });
    await expect(accepted.send(conformanceRequest())).resolves.toEqual({ accepted: true });
  });

  it.each([
    ["non-object", undefined, "options"],
    ["empty key", { apiKey: " " }, "apiKey"],
    ["http base url", { apiKey: "k", baseUrl: "http://insecure" }, "baseUrl"],
    ["bad fetch", { apiKey: "k", fetch: 3 }, "fetch"],
    ["bad timeout", { apiKey: "k", timeoutMs: 0 }, "timeoutMs"],
  ])("rejects %s", (_name, options, field) => {
    expect(() => (resendMailProvider as (value: unknown) => unknown)(options)).toThrowError(
      expect.objectContaining({ code: "SHIP_MAIL_RESEND_OPTIONS_INVALID", field }),
    );
  });
});

describe("logMailProvider", () => {
  it("records sends, forwards them to the sink and can simulate outcomes", async () => {
    const sink = vi.fn();
    const provider = logMailProvider({
      sink,
      clock: () => new Date("2026-10-22T10:00:00.000Z"),
      outcome: (request) =>
        request.idempotencyKey === "bad"
          ? { accepted: false, retryable: false, error: "simulated" }
          : { accepted: true, providerMessageId: "custom" },
    });
    await expect(provider.send(conformanceRequest({ idempotencyKey: "bad" }))).resolves.toEqual({
      accepted: false,
      retryable: false,
      error: "simulated",
    });
    await expect(provider.send(conformanceRequest({ idempotencyKey: "good" }))).resolves.toEqual({
      accepted: true,
      providerMessageId: "custom",
    });
    expect(provider.sent()).toHaveLength(1);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "good", at: new Date("2026-10-22T10:00:00.000Z") }),
    );
    provider.reset();
    expect(provider.sent()).toEqual([]);
  });
});
