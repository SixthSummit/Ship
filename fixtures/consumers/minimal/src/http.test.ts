import type { UnitOfWork } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { createNotesHttpApplication, DEFAULT_CORS_ORIGINS } from "./http.js";
import type { NotesCapabilities } from "./repository.js";

const existing = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Existing note",
  createdAt: new Date("2026-09-04T12:00:00.000Z"),
};
const unitOfWork: UnitOfWork<NotesCapabilities> = {
  kind: "ship.unit-of-work",
  id: "database.notes",
  run: async (_mode, work) =>
    work({
      notes: {
        find: async (id) => (id === existing.id ? existing : undefined),
        create: async (title) => ({ ...existing, title }),
      },
    }),
};
const [APP_ORIGIN] = DEFAULT_CORS_ORIGINS;

describe("minimal notes HTTP application", () => {
  it("answers a browser preflight for a listed origin without consumer middleware", async () => {
    const { http } = createNotesHttpApplication(unitOfWork);

    const preflight = await http.request(`/notes/${existing.id}`, {
      method: "OPTIONS",
      headers: {
        origin: APP_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-api-key",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("x-api-key");
  });

  it("marks credentialed responses and exposes the request id", async () => {
    const { http } = createNotesHttpApplication(unitOfWork);

    const response = await http.request(`/notes/${existing.id}`, {
      headers: { origin: APP_ORIGIN, "x-api-key": "golden-test-key", "x-request-id": "cors-1" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Request-Id");
    expect(response.headers.get("x-request-id")).toBe("cors-1");

    const foreign = await http.request(`/notes/${existing.id}`, {
      headers: { origin: "https://evil.golden.test", "x-api-key": "golden-test-key" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a wildcard origin because credentials are enabled", () => {
    expect(() => createNotesHttpApplication(unitOfWork, { corsOrigins: ["*"] })).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_CORS_INVALID" }),
    );
  });
});
