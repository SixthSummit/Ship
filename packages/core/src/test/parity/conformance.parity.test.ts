import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ParityFixture,
  parseParityFixtures,
  runParityFixture,
} from "@sixthsummit/ship-testing";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  type AuthProvider,
  BadRequestError,
  ConflictError,
  createApp,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  registerErrorHandlers,
  requireAuth,
  ValidationError,
} from "../../index.js";

/**
 * v4-conformance run of the parity harness: a tiny app whose routes reproduce
 * each contracted behavior, exercised by the committed fixtures. This both
 * proves the harness works and locks v4's documented contracts (Public API
 * Surface §4) — a regression in the error envelope fails here. `v3-capture`
 * fixtures (recorded from a live v3 app) drop into the same `fixtures/` dir.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const noTokenProvider: AuthProvider = {
  name: "parity-fake",
  async verify() {
    return { ok: false, reason: "missing-token" };
  },
  async resolve() {
    return null;
  },
};

function buildConformanceApp() {
  const app = createApp({});
  registerErrorHandlers(app);
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/throw/not-found", () => {
    throw new NotFoundError("Resource not found");
  });
  app.get("/throw/authentication", () => {
    throw new AuthenticationError("Authentication required");
  });
  app.get("/throw/authorization", () => {
    throw new AuthorizationError("Forbidden");
  });
  app.get("/throw/conflict", () => {
    throw new ConflictError("Already exists");
  });
  app.get("/throw/bad-request", () => {
    throw new BadRequestError("Bad request");
  });
  app.get("/throw/validation", () => {
    throw new ValidationError("Invalid input", { email: "must be a valid email" });
  });
  app.get("/throw/rate-limit", () => {
    throw new RateLimitError(30);
  });
  app.get("/throw/internal", () => {
    throw new InternalServerError("boom");
  });
  app.get("/auth/protected", requireAuth({ provider: noTokenProvider }), (c) =>
    c.json({ ok: true }),
  );
  return app;
}

function loadFixtures(): ParityFixture[] {
  const out: ParityFixture[] = [];
  for (const file of readdirSync(FIXTURES_DIR).filter((n) => n.endsWith(".jsonl"))) {
    out.push(...parseParityFixtures(readFileSync(join(FIXTURES_DIR, file), "utf8")));
  }
  return out;
}

const app = buildConformanceApp();
const fixtures = loadFixtures();

describe("v3↔v4 parity — conformance fixtures (locks v4's documented contract)", () => {
  it("loads at least one conformance fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`[${fixture.metadata.area}] ${fixture.metadata.surface} (${fixture.id})`, async () => {
      const result = await runParityFixture(app, fixture);
      if (!result.passed) {
        throw new Error(
          `parity fixture "${fixture.id}" failed:\n  - ${result.failures.join("\n  - ")}`,
        );
      }
      expect(result.passed).toBe(true);
    });
  }
});
