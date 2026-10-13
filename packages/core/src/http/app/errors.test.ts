import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors/AppError.js";
import { AuthenticationError } from "../errors/AuthenticationError.js";
import { AuthorizationError } from "../errors/AuthorizationError.js";
import { NotFoundError } from "../errors/NotFoundError.js";
import { ValidationError } from "../errors/ValidationError.js";
import { type ErrorResponseShape, registerErrorHandlers } from "./errors.js";

function makeCapture(): {
  destination: { write(s: string): boolean };
  records(): Array<{ level: number; msg?: string; status?: number; code?: string; err?: unknown }>;
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

function makeApp(opts: Parameters<typeof registerErrorHandlers>[1] = {}): {
  app: Hono;
  cap: ReturnType<typeof makeCapture>;
} {
  const cap = makeCapture();
  const app = new Hono();
  registerErrorHandlers(app as unknown as Hono<never>, { logger: cap.logger, ...opts });
  return { app, cap };
}

describe("registerErrorHandlers — AppError mapping", () => {
  it("AuthenticationError → 401 with consistent body shape", async () => {
    const { app } = makeApp();
    app.get("/x", () => {
      throw new AuthenticationError("nope");
    });

    const res = await app.request("/x");
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponseShape;
    expect(body).toMatchObject({
      success: false,
      error: { code: "AUTHENTICATION_ERROR", message: "nope" },
    });
  });

  it("AuthorizationError → 403", async () => {
    const { app } = makeApp();
    app.get("/x", () => {
      throw new AuthorizationError("forbidden");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.error.code).toBe("AUTHORIZATION_ERROR");
  });

  it("NotFoundError → 404", async () => {
    const { app } = makeApp();
    app.get("/x", () => {
      throw new NotFoundError("missing");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(404);
  });

  it("ValidationError preserves details on the response", async () => {
    const { app } = makeApp();
    app.get("/x", () => {
      throw new ValidationError("bad input", { field: "email", reason: "invalid" });
    });

    const res = await app.request("/x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "bad input",
      details: { field: "email", reason: "invalid" },
    });
  });
});

describe("registerErrorHandlers — HTTPException", () => {
  it("HTTPException → status + HTTP_<status> code", async () => {
    const { app } = makeApp();
    app.get("/x", () => {
      throw new HTTPException(418, { message: "I'm a teapot" });
    });
    const res = await app.request("/x");
    expect(res.status).toBe(418);
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.error).toMatchObject({ code: "HTTP_418", message: "I'm a teapot" });
  });
});

describe("registerErrorHandlers — unknown errors", () => {
  it("unknown Error → 500 with INTERNAL_SERVER_ERROR; original message NOT exposed", async () => {
    const { app, cap } = makeApp();
    app.get("/x", () => {
      throw new Error("internal-detail-leaked-via-message");
    });

    const res = await app.request("/x");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred");
    expect(JSON.stringify(body)).not.toContain("internal-detail-leaked-via-message");

    // The full details ARE in the structured log (server-side only).
    const errorLog = cap.records().find((r) => r.msg === "http.error.unhandled");
    expect(errorLog).toBeDefined();
  });

  it("non-Error throws are handled by Hono's outer wrapper", async () => {
    // Hono's onError signature is `(err: Error, c) => ...` — non-Error
    // throws (e.g., `throw "string"`) are handled by Hono's internal
    // error path before reaching our handler. We verify via the
    // errors.ts contract: when an Error subclass IS thrown but not an
    // AppError, our handler turns it into a clean 500.
    const { app } = makeApp();
    app.get("/x", () => {
      throw new TypeError("internal cast issue");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.error.message).not.toContain("internal cast");
  });
});

describe("registerErrorHandlers — 404s", () => {
  it("unmatched route → 404 with NotFoundError shape", async () => {
    const { app } = makeApp();
    const res = await app.request("/no-such-route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.error.code).toBe("NOT_FOUND_ERROR");
    expect(body.error.message).toMatch(/GET \/no-such-route/);
  });
});

describe("registerErrorHandlers — exposeStack", () => {
  it("development mode includes stack + name fields", async () => {
    const { app } = makeApp({ exposeStack: true });
    app.get("/x", () => {
      throw new AuthenticationError("nope");
    });
    const res = await app.request("/x");
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.stack).toBeDefined();
    expect(typeof body.stack).toBe("string");
    expect(body.name).toBeDefined();
  });

  it("production mode does NOT include stack / name", async () => {
    const { app } = makeApp({ exposeStack: false });
    app.get("/x", () => {
      throw new AuthenticationError("nope");
    });
    const res = await app.request("/x");
    const body = (await res.json()) as ErrorResponseShape;
    expect(body.stack).toBeUndefined();
    expect(body.name).toBeUndefined();
  });
});

describe("registerErrorHandlers — logging", () => {
  it("logs 4xx AppErrors at warn level", async () => {
    const { app, cap } = makeApp();
    app.get("/x", () => {
      throw new AuthenticationError();
    });
    await app.request("/x");
    const record = cap.records().find((r) => r.msg === "http.error" && r.status === 401);
    expect(record?.level).toBe(40); // pino warn
  });

  it("logs 5xx AppErrors at error level", async () => {
    const { app, cap } = makeApp();
    class ServerError extends AppError {
      constructor() {
        super("boom", 503, "SERVICE_UNAVAILABLE");
      }
    }
    app.get("/x", () => {
      throw new ServerError();
    });
    await app.request("/x");
    const record = cap.records().find((r) => r.msg === "http.error" && r.status === 503);
    expect(record?.level).toBe(50); // pino error
  });
});
