import {
  cacheInvalidationOutbox,
  defineRealtimePublicationOutbox,
  startJobRuntime,
  type TenantScope,
  type UnitOfWork,
  webhookSecret,
} from "@sixthsummit/ship-core";
import { createInMemoryMailLedger, logMailProvider } from "@sixthsummit/ship-mail";
import { defineStoragePurgeOutbox } from "@sixthsummit/ship-storage";
import {
  createInMemoryAttachmentLedger,
  createInMemoryIdempotencyStore,
  createInMemoryJobBackend,
  createInMemoryLockProvider,
  createInMemoryOutbox,
  createInMemoryRealtimeBackend,
  createInMemoryStorageAdapter,
  createInMemoryWebhookEventStore,
} from "@sixthsummit/ship-testing";
import { createInMemoryCacheBackend } from "@sixthsummit/ship-testing/cache";
import { describe, expect, it } from "vitest";
import { type CustomizedInfrastructure, publishedChannels } from "./application.js";
import type { SessionDirectory } from "./auth.js";
import { createCustomizedHttpApplication, DEFAULT_CORS_ORIGINS } from "./http.js";
import { paymentsOutbox as paymentsOutboxDefinition, reportsOutbox } from "./outbox.js";
import type { PortfolioCapabilities } from "./repository.js";

const [APP_ORIGIN] = DEFAULT_CORS_ORIGINS;
const sessions: SessionDirectory = {
  find: (token) =>
    token === "analyst-token"
      ? { actorId: "analyst", role: "analyst", tenants: ["acme"] }
      : undefined,
};

function infrastructure(): CustomizedInfrastructure {
  const unitOfWork: UnitOfWork<PortfolioCapabilities> = {
    kind: "ship.unit-of-work",
    id: "database.portfolio",
    run: async (_mode, work) =>
      work({
        portfolio: {
          kind: "ship.drizzle.tenant-repository",
          id: "portfolio.projects",
          forTenant: (_scope: TenantScope<string>) => ({
            summarize: async () => [],
            recordReportRequest: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
            upsertDocument: async () => undefined,
            readDocument: async () => undefined,
            deleteDocument: async () => false,
          }),
        },
      }),
  };
  const paymentsOutbox = createInMemoryOutbox(paymentsOutboxDefinition);
  return {
    unitOfWork,
    notifier: { adapter: "fixture", send: async () => undefined },
    outbox: createInMemoryOutbox(reportsOutbox),
    idempotency: createInMemoryIdempotencyStore(),
    cache: createInMemoryCacheBackend(),
    cacheOutbox: createInMemoryOutbox(cacheInvalidationOutbox),
    realtime: createInMemoryRealtimeBackend({ channels: publishedChannels }),
    realtimeOutbox: createInMemoryOutbox(defineRealtimePublicationOutbox(publishedChannels)),
    paymentSink: { adapter: "fixture", record: async () => undefined },
    paymentsOutbox,
    webhookEvents: createInMemoryWebhookEventStore({ outbox: paymentsOutbox }),
    webhookSecrets: { stripe: webhookSecret("whsec_fixture"), twilio: webhookSecret("auth-token") },
    jobs: createInMemoryJobBackend(),
    locks: createInMemoryLockProvider(),
    storage: createInMemoryStorageAdapter(),
    attachmentLedger: createInMemoryAttachmentLedger(),
    purgeOutbox: createInMemoryOutbox(defineStoragePurgeOutbox()),
    mailProvider: logMailProvider(),
    mailLedger: createInMemoryMailLedger(),
    scheduledTenants: ["acme"],
  };
}

describe("customized portfolio HTTP application", () => {
  it("answers preflights for operation, streaming and webhook routes", async () => {
    const { http } = createCustomizedHttpApplication(infrastructure(), sessions);
    const preflight = (path: string, method: string) =>
      http.request(path, {
        method: "OPTIONS",
        headers: { origin: APP_ORIGIN, "access-control-request-method": method },
      });

    for (const [path, method] of [
      ["/tenants/acme/portfolio", "GET"],
      ["/tenants/acme/report-progress", "POST"],
      ["/webhooks/stripe", "POST"],
    ] as const) {
      const response = await preflight(path, method);
      expect(response.status, path).toBe(204);
      expect(response.headers.get("access-control-allow-origin"), path).toBe(APP_ORIGIN);
      expect(response.headers.get("access-control-allow-credentials"), path).toBe("true");
      expect(response.headers.get("access-control-allow-methods"), path).toContain(method);
    }
  });

  it("marks a credentialed cross-origin response and exposes the request id", async () => {
    const { http } = createCustomizedHttpApplication(infrastructure(), sessions);

    const response = await http.request(
      "/tenants/acme/portfolio?states[]=open&minimumEffort=0&limit=10",
      {
        headers: {
          origin: APP_ORIGIN,
          authorization: "ShipSession analyst-token",
          "x-request-id": "cors",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Request-Id");
    expect(response.headers.get("x-request-id")).toBe("cors");
  });

  it("refuses a wildcard origin with session credentials", () => {
    expect(() =>
      createCustomizedHttpApplication(infrastructure(), sessions, { corsOrigins: ["*"] }),
    ).toThrow(expect.objectContaining({ code: "SHIP_HONO_CORS_INVALID" }));
  });

  it("signs a browser in over the session cookie beside a bearer session, with the CSRF guard on every write", async () => {
    const jobs = createInMemoryJobBackend();
    const mailProvider = logMailProvider();
    const infra = { ...infrastructure(), jobs, mailProvider };
    const { application, http } = createCustomizedHttpApplication(infra, sessions);
    await startJobRuntime(application, { backend: jobs, mode: "api" });
    const jar = new Map<string, string>();
    const absorb = (response: Response) => {
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const [name = "", value = ""] = pair.split("=");
        if (/Max-Age=0/u.test(line) || value === "") jar.delete(name);
        else jar.set(name, value);
      }
    };
    const browser = async (
      path: string,
      init: { body?: unknown; csrf?: boolean; origin?: string | null } = {},
    ) => {
      const origin = init.origin === undefined ? APP_ORIGIN : init.origin;
      const csrf = jar.get("ship_csrf");
      const response = await http.request(path, {
        method: init.body === undefined ? "GET" : "POST",
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(jar.size > 0
            ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") }
            : {}),
          ...(origin ? { origin } : {}),
          ...(init.csrf !== false && csrf ? { "x-csrf-token": csrf } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      absorb(response);
      // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON bodies
      const json: any = response.headers.get("content-type")?.includes("json")
        ? await response.json()
        : undefined;
      return { status: response.status, body: json, response };
    };
    const password = "correct horse battery staple";
    expect(
      (await browser("/auth/register", { body: { email: "ada@example.test", password } })).status,
    ).toBe(201);
    await jobs.drain();
    const mail = mailProvider.sent().at(-1)?.envelope.text ?? "";
    const verifyUrl = /https:\/\/\S+/u.exec(mail)?.[0] ?? "";
    expect(
      (
        await browser("/auth/verify-email", {
          body: { token: verifyUrl.slice(verifyUrl.lastIndexOf("/") + 1) },
        })
      ).status,
    ).toBe(200);

    // A cross-site page cannot sign the browser in (login CSRF).
    expect(
      (
        await browser("/auth/sign-in", {
          body: { email: "ada@example.test", password, transport: "cookie" },
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    const signedIn = await browser("/auth/sign-in", {
      body: { email: "ada@example.test", password, transport: "cookie" },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.session).toMatchObject({ transport: "cookie", mfaState: "none" });
    expect(signedIn.body.session.token).toBeUndefined();
    expect(signedIn.response.headers.getSetCookie().map((line) => line.split("=")[0])).toEqual([
      "ship_session",
      "ship_csrf",
    ]);
    expect(signedIn.response.headers.getSetCookie()[0]).toMatch(
      /; Secure; SameSite=Lax; HttpOnly$/u,
    );
    expect(signedIn.response.headers.get("access-control-allow-credentials")).toBe("true");

    // The cookie alone carries a reload-safe session; the CSRF echo gates writes.
    const me = await browser("/auth/me", { origin: null });
    expect(me.status).toBe(200);
    expect(me.body.session.id).toBe(signedIn.body.session.id);
    expect((await browser("/auth/sessions/revoke-all", { body: {}, csrf: false })).status).toBe(
      403,
    );
    expect(
      (await browser("/auth/sessions/revoke-all", { body: {}, origin: "https://evil.example" }))
        .status,
    ).toBe(403);

    // A native client (no cookies, no Origin) signs in with the bearer at the
    // same time; both are live sessions.
    const native = await http.request("/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.test", password }),
    });
    expect(native.status).toBe(200);
    const bearer = { body: await native.json() };
    expect(bearer.body.session).toMatchObject({
      transport: "bearer",
      token: expect.stringMatching(/^ship_s_/u),
    });
    const list = await browser("/auth/sessions", { origin: null });
    expect(list.body.sessions).toHaveLength(2);
    const viaBearer = await http.request("/auth/me", {
      headers: { authorization: `Bearer ${bearer.body.session.token}` },
    });
    expect(viaBearer.status).toBe(200);

    const out = await browser("/auth/sign-out", { body: {} });
    expect(out.status).toBe(200);
    expect(out.response.headers.getSetCookie()[0]).toMatch(/^ship_session=; .*Max-Age=0/u);
    expect(jar.has("ship_session")).toBe(false);
    expect((await browser("/auth/me", { origin: null })).status).toBe(401);
    expect(
      (
        await http.request("/auth/me", {
          headers: { authorization: `Bearer ${bearer.body.session.token}` },
        })
      ).status,
    ).toBe(200);
  });
});
