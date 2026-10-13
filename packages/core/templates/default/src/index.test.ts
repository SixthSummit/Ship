/**
 * Sample test — exercises `createApp` end-to-end without booting a server.
 * Hono apps are testable via `app.request(path, init)` which returns a
 * standard `Response`. No supertest, no port binding, no test containers.
 *
 * Replace this file with real coverage as you add modules. Pattern to follow:
 *   - service unit tests at `modules/<name>/services/<Name>Service.test.ts`
 *     (fake-DB; cover service logic + lifecycle hooks)
 *   - route integration tests at `modules/<name>/routes.test.ts`
 *     (full requireAuth → requirePermission → validate → handler chain)
 *   - mirror the harness from `modules/accounts/routes.test.ts` in the
 *     framework monorepo for canonical structure.
 */

import { describe, it, expect } from "vitest";
import { createApp, registerErrorHandlers } from "@sixthsummit/ship-api";

describe("createApp", () => {
  it("returns a Hono app that handles routes", async () => {
    const app = createApp({});
    app.get("/sample", (c) => c.json({ ok: true }));

    const res = await app.request("/sample");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves /livez and /readyz with no extra wiring", async () => {
    const app = createApp({});

    const live = await app.request("/livez");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true });

    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
  });

  it("shapes thrown errors via registerErrorHandlers", async () => {
    const app = createApp({});
    registerErrorHandlers(app);
    app.get("/boom", () => {
      throw new Error("kaboom");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error).toBeDefined();
  });
});
