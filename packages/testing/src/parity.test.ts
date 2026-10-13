import { describe, expect, it } from "vitest";
import { parseParityFixtures, runParityFixture } from "./parity.js";

describe("parity fixtures", () => {
  it("parses JSONL while ignoring comments and blank lines", () => {
    expect(
      parseParityFixtures(`
# captured contract
{"id":"health","metadata":{"area":"system","surface":"health","source":"v4-conformance"},"request":{"method":"GET","path":"/health"},"checks":[]}
`),
    ).toMatchObject([{ id: "health", request: { path: "/health" } }]);
  });

  it("reports response mismatches without throwing away the fixture", async () => {
    const [fixture] = parseParityFixtures(
      '{"id":"health","metadata":{"area":"system","surface":"health","source":"v4-conformance"},"request":{"method":"GET","path":"/health"},"checks":[{"path":"status","equals":200},{"path":"body.ok","equals":true}]}',
    );
    const result = await runParityFixture(
      { request: async () => Response.json({ ok: false }, { status: 503 }) },
      fixture,
    );

    expect(result.fixture).toBe(fixture);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      "status: expected 200, got 503",
      "body.ok: expected true, got false",
    ]);
  });
});
