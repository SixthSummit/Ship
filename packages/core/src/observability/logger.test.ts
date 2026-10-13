import { describe, expect, it } from "vitest";
import {
  createLogger,
  getRequestContext,
  runWithRequestContext,
  setRequestContextField,
} from "./logger.js";

interface CapturedRecord {
  level: number;
  msg?: string;
  requestId?: string;
  userId?: string;
  tenantId?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  firebaseCredentials?: string;
  headers?: { authorization?: string; cookie?: string };
  [key: string]: unknown;
}

function makeCapture(): {
  destination: { write(s: string): boolean };
  records(): CapturedRecord[];
} {
  const lines: string[] = [];
  return {
    destination: {
      write(s: string) {
        lines.push(s);
        return true;
      },
    },
    records: () => lines.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l)),
  };
}

describe("createLogger", () => {
  it("emits ND-JSON with msg and level", () => {
    const cap = makeCapture();
    const log = createLogger({ destination: cap.destination, pretty: false });

    log.info("hello world");
    log.error({ err: "boom" }, "something broke");

    const records = cap.records();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ msg: "hello world", level: 30 });
    expect(records[1]).toMatchObject({ msg: "something broke", level: 50, err: "boom" });
  });

  it("respects the configured level", () => {
    const cap = makeCapture();
    const log = createLogger({ destination: cap.destination, pretty: false, level: "warn" });

    log.debug("debug-line");
    log.info("info-line");
    log.warn("warn-line");
    log.error("error-line");

    const records = cap.records();
    expect(records.map((r) => r.msg)).toEqual(["warn-line", "error-line"]);
  });

  it("redacts default secret-bearing paths", () => {
    const cap = makeCapture();
    const log = createLogger({ destination: cap.destination, pretty: false });

    log.info(
      {
        password: "p@ssw0rd",
        token: "abc.def.ghi",
        apiKey: "secret-key",
        firebaseCredentials: "{ ... }",
        headers: { authorization: "Bearer xyz", cookie: "session=abc" },
      },
      "redaction test",
    );

    const records = cap.records();
    expect(records[0].password).toBe("[REDACTED]");
    expect(records[0].token).toBe("[REDACTED]");
    expect(records[0].apiKey).toBe("[REDACTED]");
    expect(records[0].firebaseCredentials).toBe("[REDACTED]");
    expect(records[0].headers?.authorization).toBe("[REDACTED]");
    expect(records[0].headers?.cookie).toBe("[REDACTED]");
  });

  it("accepts extra redaction paths", () => {
    const cap = makeCapture();
    const log = createLogger({
      destination: cap.destination,
      pretty: false,
      extraRedactPaths: ["webhookSignature"],
    });

    log.info({ webhookSignature: "sig-value", normal: "ok" }, "extra redact");

    const records = cap.records();
    expect(records[0]).toMatchObject({ webhookSignature: "[REDACTED]", normal: "ok" });
  });

  it("attaches request-context fields via the ALS mixin", () => {
    const cap = makeCapture();
    const log = createLogger({ destination: cap.destination, pretty: false });

    runWithRequestContext({ requestId: "req-1", userId: "u-1", tenantId: "t-1" }, () => {
      log.info("with context");
    });
    log.info("without context");

    const records = cap.records();
    expect(records[0]).toMatchObject({
      msg: "with context",
      requestId: "req-1",
      userId: "u-1",
      tenantId: "t-1",
    });
    expect(records[1].msg).toBe("without context");
    expect(records[1].requestId).toBeUndefined();
    expect(records[1].userId).toBeUndefined();
  });

  it("includes `extra` context fields under their own keys", () => {
    const cap = makeCapture();
    const log = createLogger({ destination: cap.destination, pretty: false });

    runWithRequestContext(
      { requestId: "req-2", extra: { traceId: "trace-x", route: "/me" } },
      () => {
        log.info("hit");
      },
    );

    const records = cap.records();
    expect(records[0]).toMatchObject({
      requestId: "req-2",
      traceId: "trace-x",
      route: "/me",
    });
  });

  it("child loggers inherit redaction and context binding", () => {
    const cap = makeCapture();
    const log = createLogger({ destination: cap.destination, pretty: false });
    const child = log.child({ module: "accounts" });

    runWithRequestContext({ requestId: "req-3" }, () => {
      child.info({ password: "leaked" }, "from child");
    });

    const records = cap.records();
    expect(records[0]).toMatchObject({
      module: "accounts",
      requestId: "req-3",
      password: "[REDACTED]",
      msg: "from child",
    });
  });

  it("setRequestContextField mutates the active context and returns true", () => {
    const cap = makeCapture();
    const log = createLogger({ destination: cap.destination, pretty: false });

    runWithRequestContext({ requestId: "req-4" }, () => {
      const updated = setRequestContextField("userId", "late-bound-user");
      expect(updated).toBe(true);
      expect(getRequestContext()).toMatchObject({
        requestId: "req-4",
        userId: "late-bound-user",
      });
      log.info("after set");
    });

    const records = cap.records();
    expect(records[0]).toMatchObject({
      requestId: "req-4",
      userId: "late-bound-user",
    });
  });

  it("setRequestContextField returns false when no context is active", () => {
    expect(setRequestContextField("userId", "x")).toBe(false);
    expect(getRequestContext()).toBeUndefined();
  });
});
