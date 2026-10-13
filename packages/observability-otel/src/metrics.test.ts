import { metrics } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetMetricsForTests,
  getFrameworkMeter,
  getMetricsServerHandle,
  isMetricsDisabledByEnv,
  shutdownMetricsServer,
  startMetricsServer,
} from "./metrics.js";

describe("Prometheus metrics exporter", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.METRICS_ENABLED;
  const originalPort = process.env.METRICS_PORT;
  const originalHost = process.env.METRICS_HOST;

  beforeEach(() => {
    __resetMetricsForTests();
    metrics.disable();
  });

  afterEach(async () => {
    await shutdownMetricsServer().catch(() => undefined);
    metrics.disable();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalEnabled === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = originalEnabled;
    if (originalPort === undefined) delete process.env.METRICS_PORT;
    else process.env.METRICS_PORT = originalPort;
    if (originalHost === undefined) delete process.env.METRICS_HOST;
    else process.env.METRICS_HOST = originalHost;
  });

  describe("isMetricsDisabledByEnv", () => {
    it("returns true when NODE_ENV is test", () => {
      process.env.NODE_ENV = "test";
      process.env.METRICS_ENABLED = "true";
      expect(isMetricsDisabledByEnv()).toBe(true);
    });

    it("returns true when METRICS_ENABLED is unset", () => {
      process.env.NODE_ENV = "production";
      delete process.env.METRICS_ENABLED;
      expect(isMetricsDisabledByEnv()).toBe(true);
    });

    it("returns true when METRICS_ENABLED is anything other than 'true'", () => {
      process.env.NODE_ENV = "production";
      process.env.METRICS_ENABLED = "1";
      expect(isMetricsDisabledByEnv()).toBe(true);
    });

    it("returns false in production with explicit METRICS_ENABLED=true", () => {
      process.env.NODE_ENV = "production";
      process.env.METRICS_ENABLED = "true";
      expect(isMetricsDisabledByEnv()).toBe(false);
    });
  });

  describe("startMetricsServer", () => {
    it("returns undefined when env-disabled (test default)", async () => {
      process.env.NODE_ENV = "test";
      const handle = await startMetricsServer({ serviceName: "svc" });
      expect(handle).toBeUndefined();
      expect(getMetricsServerHandle()).toBeUndefined();
    });

    it("returns undefined when explicitly disabled regardless of env", async () => {
      process.env.NODE_ENV = "production";
      process.env.METRICS_ENABLED = "true";
      const handle = await startMetricsServer({
        serviceName: "svc",
        disabled: true,
      });
      expect(handle).toBeUndefined();
    });

    it("starts and registers the global MeterProvider when opted in", async () => {
      const handle = await startMetricsServer({
        serviceName: "test-svc",
        disabled: false,
        preventServerStart: true,
      });
      expect(handle).toBeDefined();
      expect(handle?.port).toBe(9464);
      expect(handle?.endpoint).toBe("/metrics");
      expect(metrics.getMeterProvider()).toBe(handle?.meterProvider);
    });

    it("is idempotent — second call returns the same handle", async () => {
      const first = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        preventServerStart: true,
      });
      const second = await startMetricsServer({
        serviceName: "different-svc",
        disabled: false,
        preventServerStart: true,
      });
      expect(second).toBe(first);
    });

    it("resolves port from METRICS_PORT env var", async () => {
      process.env.METRICS_PORT = "19999";
      const handle = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        preventServerStart: true,
      });
      expect(handle?.port).toBe(19999);
    });

    it("explicit port option overrides METRICS_PORT env var", async () => {
      process.env.METRICS_PORT = "19999";
      const handle = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        port: 18888,
        preventServerStart: true,
      });
      expect(handle?.port).toBe(18888);
    });

    it("resolves host from METRICS_HOST env var", async () => {
      process.env.METRICS_HOST = "127.0.0.1";
      const handle = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        preventServerStart: true,
      });
      expect(handle?.host).toBe("127.0.0.1");
    });

    it("respects custom endpoint path", async () => {
      const handle = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        preventServerStart: true,
        endpoint: "/internal/metrics",
      });
      expect(handle?.endpoint).toBe("/internal/metrics");
    });
  });

  describe("getFrameworkMeter", () => {
    it("returns a no-op meter before startMetricsServer runs", () => {
      const meter = getFrameworkMeter("ship-api.unstarted");
      const counter = meter.createCounter("noop_counter");
      expect(() => counter.add(1)).not.toThrow();
    });

    it("returns a real meter after startMetricsServer runs", async () => {
      const handle = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        preventServerStart: true,
      });
      expect(handle).toBeDefined();
      const meter = getFrameworkMeter("ship-api.test");
      const counter = meter.createCounter("requests_total");
      counter.add(1, { route: "/me" });
      counter.add(2, { route: "/me" });
    });
  });

  describe("counter increments surface in the exporter output", () => {
    it("renders incremented counter as Prometheus exposition format", async () => {
      const handle = await startMetricsServer({
        serviceName: "ship-api-test",
        serviceVersion: "0.0.0-test",
        disabled: false,
        preventServerStart: true,
      });
      expect(handle).toBeDefined();

      const meter = getFrameworkMeter("ship-api.test");
      const counter = meter.createCounter("ship_test_requests_total", {
        description: "test counter",
      });
      counter.add(3, { route: "me" });
      counter.add(2, { route: "accounts" });

      const body = await scrapeMetrics(handle!.exporter);
      expect(body).toContain("ship_test_requests_total");
      expect(body).toMatch(/ship_test_requests_total\{[^}]*route="me"[^}]*\}\s+3/);
      expect(body).toMatch(/ship_test_requests_total\{[^}]*route="accounts"[^}]*\}\s+2/);
    });
  });

  describe("shutdownMetricsServer", () => {
    it("is a no-op when never started", async () => {
      await expect(shutdownMetricsServer()).resolves.toBeUndefined();
    });

    it("clears the handle so subsequent starts produce a fresh provider", async () => {
      const first = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        preventServerStart: true,
      });
      await shutdownMetricsServer();
      expect(getMetricsServerHandle()).toBeUndefined();

      const second = await startMetricsServer({
        serviceName: "svc",
        disabled: false,
        preventServerStart: true,
      });
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
    });
  });
});

/**
 * Drive the exporter's request handler with a fake req/res so we can
 * assert the rendered exposition without binding a TCP port.
 */
async function scrapeMetrics(
  exporter: import("@opentelemetry/exporter-prometheus").PrometheusExporter,
): Promise<string> {
  const chunks: Buffer[] = [];
  let resolveBody!: (body: string) => void;
  const done = new Promise<string>((resolve) => {
    resolveBody = resolve;
  });

  const fakeReq = {} as import("http").IncomingMessage;
  const fakeRes = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    write(chunk: string | Buffer): boolean {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer): void {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    },
  } as unknown as import("http").ServerResponse;

  exporter.getMetricsRequestHandler(fakeReq, fakeRes);
  return done;
}
