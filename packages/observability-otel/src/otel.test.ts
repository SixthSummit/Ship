import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetOtelForTests,
  getOtelSdk,
  isOtelDisabledByEnv,
  shutdownOtel,
  startOtel,
} from "./otel.js";

describe("OTel SDK initialization", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDisabled = process.env.OTEL_SDK_DISABLED;

  beforeEach(() => {
    __resetOtelForTests();
  });

  afterEach(async () => {
    await shutdownOtel().catch(() => undefined);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDisabled === undefined) delete process.env.OTEL_SDK_DISABLED;
    else process.env.OTEL_SDK_DISABLED = originalDisabled;
  });

  describe("isOtelDisabledByEnv", () => {
    it("returns true when NODE_ENV is test", () => {
      process.env.NODE_ENV = "test";
      delete process.env.OTEL_SDK_DISABLED;
      expect(isOtelDisabledByEnv()).toBe(true);
    });

    it("returns true when OTEL_SDK_DISABLED is 'true'", () => {
      process.env.NODE_ENV = "production";
      process.env.OTEL_SDK_DISABLED = "true";
      expect(isOtelDisabledByEnv()).toBe(true);
    });

    it("returns false in production with no opt-out", () => {
      process.env.NODE_ENV = "production";
      delete process.env.OTEL_SDK_DISABLED;
      expect(isOtelDisabledByEnv()).toBe(false);
    });

    it("treats OTEL_SDK_DISABLED='false' as not-disabled (only 'true' opts out)", () => {
      process.env.NODE_ENV = "production";
      process.env.OTEL_SDK_DISABLED = "false";
      expect(isOtelDisabledByEnv()).toBe(false);
    });
  });

  describe("startOtel", () => {
    it("returns undefined when env-disabled (test default)", () => {
      process.env.NODE_ENV = "test";
      const sdk = startOtel({ serviceName: "test-svc" });
      expect(sdk).toBeUndefined();
      expect(getOtelSdk()).toBeUndefined();
    });

    it("returns undefined when explicitly disabled regardless of env", () => {
      process.env.NODE_ENV = "production";
      delete process.env.OTEL_SDK_DISABLED;
      const sdk = startOtel({ serviceName: "test-svc", disabled: true });
      expect(sdk).toBeUndefined();
    });

    it("is idempotent — second call returns the same instance (or undefined)", () => {
      process.env.NODE_ENV = "test";
      const first = startOtel({ serviceName: "test-svc" });
      const second = startOtel({ serviceName: "different-svc" });
      expect(second).toBe(first);
    });

    it("boots the real SDK and correlates a pino record with an emitted span", () => {
      const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
      const probe = `
        const otel = await import("./src/otel.ts");
        const sdk = otel.startOtel({ serviceName: "ship-api-otel-probe" });
        if (!sdk) throw new Error("SDK did not start");

        const { trace } = await import("@opentelemetry/api");
        const { createRequire } = await import("node:module");
        const pino = createRequire(import.meta.url)("pino");
        const records = [];
        const logger = pino({}, {
          write(line) { records.push(JSON.parse(line)); },
        });

        await trace.getTracer("ship-api-probe").startActiveSpan(
          "ship-api.otel.probe",
          async (span) => {
            logger.info("correlated");
            span.end();
          },
        );
        await otel.shutdownOtel();

        const record = records.find(({ msg }) => msg === "correlated");
        if (!record?.trace_id || !record?.span_id) {
          throw new Error(\`missing pino correlation: \${JSON.stringify(record)}\`);
        }
        console.log("SHIP_API_OTEL_PROBE_OK", record.trace_id, record.span_id);
      `;

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", probe],
        {
          cwd: packageDirectory,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "production",
            OTEL_SDK_DISABLED: "false",
            OTEL_TRACES_EXPORTER: "console",
            OTEL_METRICS_EXPORTER: "none",
            OTEL_LOGS_EXPORTER: "none",
          },
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SHIP_API_OTEL_PROBE_OK");
      expect(result.stdout).toContain("ship-api.otel.probe");
    });
  });

  describe("shutdownOtel", () => {
    it("is a no-op when never started", async () => {
      await expect(shutdownOtel()).resolves.toBeUndefined();
    });
  });
});
