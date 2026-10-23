import {
  cacheInvalidationOutbox,
  defineRealtimePublicationOutbox,
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
});
