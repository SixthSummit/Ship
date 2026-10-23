import { describe, expect, it } from "vitest";
import { corsFromEnv, createHttp } from "./http.js";

const ORIGIN = "https://app.example.test";

describe("{{PROJECT_NAME}} HTTP", () => {
  it("parses the CORS_ORIGINS allowlist", () => {
    expect(corsFromEnv(undefined)).toBeUndefined();
    expect(corsFromEnv(" , ")).toBeUndefined();
    expect(corsFromEnv(` ${ORIGIN}, https://admin.example.test `)).toEqual({
      origin: [ORIGIN, "https://admin.example.test"],
      credentials: true,
    });
  });

  it("answers a cross-origin preflight for a listed origin", async () => {
    const http = createHttp({ CORS_ORIGINS: ORIGIN });

    const preflight = await http.request("/health", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

    const response = await http.request("/health", { headers: { origin: ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Request-Id");
  });

  it("emits no cross-origin headers without an allowlist", async () => {
    const response = await createHttp({}).request("/health", { headers: { origin: ORIGIN } });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a wildcard allowlist because credentials are enabled", () => {
    expect(() => createHttp({ CORS_ORIGINS: "*" })).toThrow(/credentials: true/u);
  });
});
