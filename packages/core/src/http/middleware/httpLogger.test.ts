import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { getRequestContext } from "../../app/context/RequestContext.js";
import { httpLogger } from "./httpLogger.js";

interface CapturedRecord {
  level: number;
  msg?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  requestId?: string;
  err?: unknown;
  [key: string]: unknown;
}

function makeCapture(): {
  destination: { write(s: string): boolean };
  records(): CapturedRecord[];
  logger: pino.Logger;
} {
  const lines: string[] = [];
  const destination = {
    write(s: string) {
      lines.push(s);
      return true;
    },
  };
  const logger = pino({ level: "debug" }, destination);
  return {
    destination,
    records: () => lines.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l)),
    logger,
  };
}

describe("httpLogger", () => {
  it("generates a request ID when none is on the request and echoes it on the response", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger, generateId: () => "test-id-1" }));
    app.get("/x", (c) => c.json({ ok: true }));

    const res = await app.request("/x");
    expect(res.headers.get("x-request-id")).toBe("test-id-1");

    const records = cap.records();
    const completion = records.find((r) => r.msg === "http.request");
    expect(completion).toMatchObject({
      method: "GET",
      path: "/x",
      status: 200,
      requestId: "test-id-1",
    });
    expect(typeof completion!.durationMs).toBe("number");
  });

  it("uses the incoming X-Request-Id header when present", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", (c) => c.json({}));

    const res = await app.request("/x", { headers: { "x-request-id": "incoming-abc" } });
    expect(res.headers.get("x-request-id")).toBe("incoming-abc");
    const completion = cap.records().find((r) => r.msg === "http.request");
    expect(completion?.requestId).toBe("incoming-abc");
  });

  it("propagates the request ID into RequestContext for downstream handlers", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger, generateId: () => "ctx-1" }));

    let observed: string | undefined;
    app.get("/x", (c) => {
      observed = getRequestContext()?.requestId;
      return c.json({});
    });

    await app.request("/x");
    expect(observed).toBe("ctx-1");
  });

  it("logs at error level for 5xx responses", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.onError((_err, c) => c.json({ err: true }, 500));
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", () => {
      throw new Error("oops");
    });

    await app.request("/x");
    const completion = cap
      .records()
      .find((r) => r.msg === "http.request" || r.msg === "http.request.error");
    expect(completion?.level).toBe(50); // pino error level
    expect(completion?.status).toBe(500);
  });

  it("logs the failed request when downstream throws (with or without onError)", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", () => {
      throw new Error("uncaught");
    });

    await app.request("/x");
    const records = cap.records();
    // Hono's internal error handling may catch the throw before it
    // re-enters our middleware's try/catch — so we accept either
    // `http.request.error` (we saw the throw) or `http.request` with
    // status 500 (Hono surfaced it as a 500 response). Either is correct
    // logging behavior.
    const failureLog = records.find(
      (r) =>
        (r.msg === "http.request.error" || r.msg === "http.request") &&
        (r.err !== undefined || r.status === 500),
    );
    expect(failureLog).toBeDefined();
    expect(failureLog?.level).toBe(50); // error level either way
  });

  it("logs http.request.start at debug level when logStart: true", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger, logStart: true }));
    app.get("/x", (c) => c.json({}));

    await app.request("/x");
    const start = cap.records().find((r) => r.msg === "http.request.start");
    expect(start).toMatchObject({ method: "GET", path: "/x", level: 20 }); // debug
  });

  it("does NOT log http.request.start by default", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", (c) => c.json({}));

    await app.request("/x");
    expect(cap.records().some((r) => r.msg === "http.request.start")).toBe(false);
  });
});

describe("httpLogger — query-string redaction (F11)", () => {
  it("keeps `path` route-only and emits a separate `query` field with sensitive keys redacted", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/reset", (c) => c.json({}));

    await app.request("/reset?token=abc123");
    const completion = cap.records().find((r) => r.msg === "http.request");
    expect(completion?.path).toBe("/reset");
    expect(completion?.query).toEqual({ token: "<redacted>" });
  });

  it("redacts each sensitive key by name while passing through unrelated params", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/users", (c) => c.json({}));

    await app.request("/users?page=1&token=abc&sort=name&signature=xxx");
    const completion = cap.records().find((r) => r.msg === "http.request");
    expect(completion?.query).toEqual({
      page: "1",
      token: "<redacted>",
      sort: "name",
      signature: "<redacted>",
    });
  });

  it("redaction is case-insensitive on the param key", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", (c) => c.json({}));

    await app.request("/x?Token=A&SECRET=B&Sig=C&CODE=D");
    const completion = cap.records().find((r) => r.msg === "http.request");
    expect(completion?.query).toEqual({
      Token: "<redacted>",
      SECRET: "<redacted>",
      Sig: "<redacted>",
      CODE: "<redacted>",
    });
  });

  it("redacts the OAuth-flow shapes (state, code, access_token, id_token, refresh_token)", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/cb", (c) => c.json({}));

    await app.request("/cb?state=abc&code=xyz&access_token=at&id_token=it&refresh_token=rt");
    const completion = cap.records().find((r) => r.msg === "http.request");
    expect(completion?.query).toEqual({
      state: "<redacted>",
      code: "<redacted>",
      access_token: "<redacted>",
      id_token: "<redacted>",
      refresh_token: "<redacted>",
    });
  });

  it("omits `query` (or sets it to undefined) when no query string is present", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", (c) => c.json({}));

    await app.request("/x");
    const completion = cap.records().find((r) => r.msg === "http.request");
    expect(completion?.query).toBeUndefined();
  });

  it("handles repeated keys (URLSearchParams flattens; last value wins after redact)", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", (c) => c.json({}));

    await app.request("/x?token=v1&token=v2");
    const completion = cap.records().find((r) => r.msg === "http.request");
    // Either flattened to a single redacted entry, or an array of redactions.
    expect(JSON.stringify(completion?.query)).toContain("<redacted>");
    expect(JSON.stringify(completion?.query)).not.toContain("v1");
    expect(JSON.stringify(completion?.query)).not.toContain("v2");
  });

  it("does not crash on a request with an empty query (`?` only)", async () => {
    const cap = makeCapture();
    const app = new Hono();
    app.use("*", httpLogger({ logger: cap.logger }));
    app.get("/x", (c) => c.json({}));

    await app.request("/x?");
    const completion = cap.records().find((r) => r.msg === "http.request");
    expect(completion?.path).toBe("/x");
  });
});
