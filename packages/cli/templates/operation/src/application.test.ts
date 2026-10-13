import { createExecutor } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { app } from "./application.js";

describe("{{PROJECT_NAME}} application", () => {
  it("executes the health operation directly", async () => {
    const result = await createExecutor(app).run("system.health", {}, { requestId: "unit-health" });

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { ok: true, service: "{{PACKAGE_NAME}}" },
      requestId: "unit-health",
    });
  });
});
