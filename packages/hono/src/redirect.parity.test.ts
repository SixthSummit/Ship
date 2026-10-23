/**
 * Compat-versus-kernel redirect parity (SAPI-653).
 *
 * The compatibility line answers an OAuth-style callback with Hono's
 * `c.redirect(location, 302)` after reading `c.req.query("code")`, which takes
 * the first scalar value of a repeated key and never interprets bracket keys.
 * The kernel line declares the same route as a bodiless redirect operation with
 * `queryParsing: "first-value"`. Identical recorded requests must produce the
 * same status, `Location`, empty body and absent content type on both lines,
 * including the handler-chosen failure redirects a callback uses instead of a
 * JSON error.
 */
import { createApp, registerErrorHandlers } from "@sixthsummit/ship-api";
import {
  defineApp,
  defineModule,
  defineOperation,
  publicAccess,
  respond,
} from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHonoAdapter } from "./adapter.js";
import { http } from "./transport.js";

const FRONTEND = "https://app.example.test/settings/calendar";
const EXPECTED_STATE = "state-1";

function callbackLocation(code: string | undefined, state: string | undefined): string {
  if (!code || !state) return `${FRONTEND}?error=missing_parameters`;
  if (state !== EXPECTED_STATE) return `${FRONTEND}?error=invalid_state`;
  return `${FRONTEND}?connected=true&code=${encodeURIComponent(code)}`;
}

function compatApp() {
  const app = createApp();
  registerErrorHandlers(app);
  // The compat oracle reads the raw query on purpose: this is the legacy
  // first-scalar behaviour the kernel projection must reproduce.
  app.get("/calendar/oauth/google/callback", (c) =>
    c.redirect(callbackLocation(c.req.query("code"), c.req.query("state")), 302),
  );
  return app;
}

function kernelApp() {
  const callback = defineOperation({
    id: "calendar.oauth-callback",
    transport: http.get("/calendar/oauth/google/callback", {
      response: "redirect",
      queryParsing: "first-value",
    }),
    input: { query: z.object({ code: z.string().optional(), state: z.string().optional() }) },
    output: { 302: z.undefined() },
    successStatus: 302,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: ({ input }) =>
      respond(302, undefined, {
        headers: { Location: callbackLocation(input.query.code, input.query.state) },
      }),
  });
  const module = defineModule({
    id: "calendar",
    operations: [callback],
    providers: [],
    imports: [],
    exports: [],
  });
  return createHonoAdapter(defineApp({ id: "redirect-parity", modules: [module] }));
}

const recorded = [
  ["valid", "?code=4%2FabcDEF&state=state-1"],
  ["repeated scalar keys use the first value", "?code=first&code=second&state=state-1&state=other"],
  ["bracket keys are not scalar values", "?code%5B%5D=bracket&code=scalar&state=state-1"],
  ["bracket-only code is missing", "?code%5B%5D=bracket&state=state-1"],
  ["nested bracket key is a distinct key", "?code=c&state%5Bextra%5D=x&state=state-1"],
  ["missing code", "?state=state-1"],
  ["missing state", "?code=c"],
  ["tampered state", "?code=c&state=forged"],
  ["empty query", ""],
] as const;

describe("redirect parity: compat c.redirect() versus kernel declared redirect", () => {
  const compat = compatApp();
  const kernel = kernelApp();

  it.each(recorded)("%s", async (_label, search) => {
    const path = `/calendar/oauth/google/callback${search}`;
    const [legacy, projected] = await Promise.all([
      compat.request(path, { redirect: "manual" }),
      kernel.request(path, { redirect: "manual" }),
    ]);

    expect(projected.status).toBe(legacy.status);
    expect(projected.status).toBe(302);
    expect(projected.headers.get("location")).toBe(legacy.headers.get("location"));
    expect(projected.headers.get("content-type")).toBeNull();
    expect(legacy.headers.get("content-type")).toBeNull();
    expect(await projected.text()).toBe("");
    expect(await legacy.text()).toBe("");
  });

  it("records the one deliberate divergence: the kernel always correlates a request id", async () => {
    const path = "/calendar/oauth/google/callback?code=c&state=state-1";
    const legacy = await compat.request(path);
    const projected = await kernel.request(path, { headers: { "x-request-id": "parity-1" } });

    expect(legacy.headers.get("x-request-id")).toBeNull();
    expect(projected.headers.get("x-request-id")).toBe("parity-1");
  });
});
