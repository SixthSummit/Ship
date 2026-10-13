/**
 * v3↔v4 behavioral-parity harness (A2-6).
 *
 * Exercises a v4 app with a recorded request and asserts the response matches a
 * set of checks — either a v4-conformance contract or a behavior captured from a
 * live v3 app (the parity oracle). Pure + in-process (Hono `app.request`), no
 * Docker. Shipped via `@sixthsummit/ship-testing` so a consumer's migrated
 * app can run its own captured fixtures. See docs/v4/tooling/parity-harness.md.
 */

/** Anything with Hono's `.request()` — the v4 app under test. */
export interface RequestableApp {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface ParityCheck {
  /** Dot-path into the captured response: `status`, `headers.<lowercased>`, `body.<...>`. */
  path: string;
  /** Deep-equality assertion. */
  equals?: unknown;
  /** Presence assertion (`true` = must be present, `false` = must be absent). */
  exists?: boolean;
}

export interface ParityFixture {
  id: string;
  metadata: {
    area: string;
    /** The behavioral contract under test, e.g. "401 on missing token". */
    surface: string;
    /**
     * `v4-conformance` = encodes a documented v4 contract (ships green).
     * `v3-capture` = recorded from a live v3 app; asserts the v4 build matches.
     */
    source: "v3-capture" | "v4-conformance";
    [k: string]: unknown;
  };
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  checks: ParityCheck[];
}

export interface ParityResult {
  fixture: ParityFixture;
  passed: boolean;
  failures: string[];
}

/** Parse a JSONL fixture file (skips blank lines + `#` comments). */
export function parseParityFixtures(jsonl: string): ParityFixture[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as ParityFixture);
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function resolvePath(captured: CapturedResponse, path: string): unknown {
  let cur: unknown = captured;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Exercise `app` with the fixture's request and evaluate its checks. */
export async function runParityFixture(
  app: RequestableApp,
  fixture: ParityFixture,
): Promise<ParityResult> {
  const { method, path, headers, body } = fixture.request;
  const init: RequestInit = { method };
  if (body !== undefined && body !== null) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "content-type": "application/json", ...(headers ?? {}) };
  } else if (headers) {
    init.headers = headers;
  }

  const res = await app.request(path, init);
  const rawText = await res.text();
  let parsedBody: unknown = rawText;
  if (rawText.length > 0) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      /* non-JSON body — keep the raw text */
    }
  } else {
    parsedBody = null;
  }

  const captured: CapturedResponse = {
    status: res.status,
    headers: Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])),
    body: parsedBody,
  };

  const failures: string[] = [];
  for (const check of fixture.checks) {
    const actual = resolvePath(captured, check.path);
    if (check.exists !== undefined) {
      const present = actual !== undefined;
      if (present !== check.exists) {
        failures.push(
          `${check.path}: expected ${check.exists ? "present" : "absent"}, got ${present ? "present" : "absent"}`,
        );
      }
    }
    if (check.equals !== undefined && JSON.stringify(actual) !== JSON.stringify(check.equals)) {
      failures.push(
        `${check.path}: expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  return { fixture, passed: failures.length === 0, failures };
}
