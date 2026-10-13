import { defineJob as defineCompatJob, JobRegistry } from "@sixthsummit/ship-api";
import { defineApp, defineJob, defineModule } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runJobOnce } from "./jobs.js";

/**
 * Parity between the compatibility `defineJob` (`@sixthsummit/ship-api`,
 * BullMQ-registry based) and the kernel `defineJob`: one business handler,
 * invoked through both declaration paths, yields the same observable result.
 */
interface DigestPayload {
  readonly tenantId: string;
  readonly values: readonly number[];
}

function digest(payload: DigestPayload) {
  const total = payload.values.reduce((sum, value) => sum + value, 0);
  return { tenantId: payload.tenantId, total, count: payload.values.length };
}

describe("compat and kernel defineJob parity", () => {
  const payload: DigestPayload = { tenantId: "acme", values: [3, 4, 5] };

  it("produces the same result for the same handler and payload", async () => {
    const registry = new JobRegistry();
    const compat = defineCompatJob<DigestPayload, ReturnType<typeof digest>>(
      { queue: "reports", name: "digest", handler: async (input) => digest(input) },
      registry,
    );
    const compatResult = await (registry.find("reports", "digest") ?? compat).handler(payload, {
      job: { id: "run-1" } as never,
      context: { requestId: "job:run-1" },
    });

    const kernel = defineJob({
      id: "reports.digest",
      input: z.object({ tenantId: z.string().min(1), values: z.array(z.number()) }),
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel" },
      retry: { attempts: 1, backoff: { initialMs: 1 } },
      transaction: "none",
      dependencies: {},
      handler: async ({ input }) => digest(input),
    });
    const app = defineApp({
      id: "parity-jobs",
      modules: [
        defineModule({
          id: "reports",
          operations: [kernel],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    const kernelResult = await runJobOnce(app, "reports.digest", payload, { requestId: "run-1" });

    expect(kernelResult).toMatchObject({ ok: true, status: 200, requestId: "run-1" });
    if (!kernelResult.ok) throw new Error("unreachable");
    expect(kernelResult.data).toEqual(compatResult);
    expect(compatResult).toEqual({ tenantId: "acme", total: 12, count: 3 });
  });

  it("rejects an invalid payload where the compat path would run the handler blind", async () => {
    const registry = new JobRegistry();
    defineCompatJob<DigestPayload>(
      { queue: "reports", name: "digest", handler: async (input) => digest(input) },
      registry,
    );
    const kernel = defineJob({
      id: "reports.digest",
      input: z.object({ tenantId: z.string().min(1), values: z.array(z.number()) }),
      trigger: { kind: "enqueue" },
      concurrency: { mode: "parallel" },
      retry: { attempts: 1, backoff: { initialMs: 1 } },
      transaction: "none",
      dependencies: {},
      handler: async ({ input }) => digest(input),
    });
    const app = defineApp({
      id: "parity-jobs",
      modules: [
        defineModule({
          id: "reports",
          operations: [kernel],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    await expect(
      registry.find("reports", "digest")?.handler({ tenantId: "acme" } as never, {
        job: {} as never,
        context: { requestId: "job:run-2" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(runJobOnce(app, "reports.digest", { tenantId: "acme" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
