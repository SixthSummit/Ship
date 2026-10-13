import { createHonoAdapter } from "@sixthsummit/ship-hono";
import { describe, expect, it } from "vitest";
import { app } from "./application.js";

describe("{{PROJECT_NAME}} HTTP boundary", () => {
  it("projects the same health operation onto Hono", async () => {
    const response = await createHonoAdapter(app).request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "{{PACKAGE_NAME}}",
    });
  });
});
