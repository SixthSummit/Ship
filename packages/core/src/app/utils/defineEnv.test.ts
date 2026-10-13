import { describe, expect, it, vi } from "vitest";
import { defineEnv, type EnvSchema, type EnvSchemaIssue, scrubSecrets } from "./defineEnv.js";

function makeSchema<T>(
  parser: (
    data: unknown,
  ) => { success: true; data: T } | { success: false; issues: EnvSchemaIssue[] },
): EnvSchema<T> {
  return {
    safeParse(data) {
      const r = parser(data);
      return r.success
        ? { success: true, data: r.data }
        : { success: false, error: { issues: r.issues } };
    },
  };
}

describe("defineEnv", () => {
  it("returns parsed data on success", () => {
    const schema = makeSchema<{ FOO: string }>((data) => {
      const env = data as Record<string, string | undefined>;
      if (typeof env.FOO === "string") return { success: true, data: { FOO: env.FOO } };
      return { success: false, issues: [{ path: ["FOO"], message: "required" }] };
    });

    const result = defineEnv(schema, { source: { FOO: "bar" } });
    expect(result).toEqual({ FOO: "bar" });
  });

  it("calls onFailure with issues when schema rejects", () => {
    const schema = makeSchema<{ FOO: string }>(() => ({
      success: false,
      issues: [{ path: ["FOO"], message: "required", code: "invalid_type" }],
    }));

    const onFailure = vi.fn(() => {
      throw new Error("aborted");
    }) as unknown as (issues: ReadonlyArray<EnvSchemaIssue>) => never;

    expect(() => defineEnv(schema, { source: {}, onFailure })).toThrow("aborted");
    expect(onFailure).toHaveBeenCalledOnce();
    const issues = (onFailure as unknown as { mock: { calls: [ReadonlyArray<EnvSchemaIssue>][] } })
      .mock.calls[0][0];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: ["FOO"], message: "required" });
  });

  it("default onFailure logs each issue and exits", () => {
    const schema = makeSchema<{ A: string }>(() => ({
      success: false,
      issues: [
        { path: ["A"], message: "required" },
        { path: ["B", "nested"], message: "must be number", code: "invalid_type" },
      ],
    }));

    const errorSpy = vi.fn();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      expect(() => defineEnv(schema, { source: {}, logger: { error: errorSpy } })).toThrow(
        "exit:1",
      );

      const lines = errorSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(lines).toMatch(/Environment validation failed/);
      expect(lines).toMatch(/A: required/);
      expect(lines).toMatch(/B\.nested: must be number/);
      expect(lines).toMatch(/\[invalid_type\]/);
      expect(lines).toMatch(/Total: 2 issue\(s\)/);
    } finally {
      exitSpy.mockRestore();
    }
  });

  describe("scrubSecrets — failure-log redaction (F8)", () => {
    it("redacts OpenAI/Anthropic-shaped sk- tokens", () => {
      const input = `expected sk-prefix, got "sk-test_realsecretwouldgohere_1234567890"`;
      expect(scrubSecrets(input)).toContain("<redacted>");
      expect(scrubSecrets(input)).not.toContain("realsecretwouldgohere");
    });

    it("redacts Slack-shaped xoxb / xoxp / xoxa tokens", () => {
      const examples = [
        `failed for token "xoxb-1234567890-abcdefghijk"`,
        `failed for token "xoxp-9876543210-zyxwvutsrqp"`,
        `failed for token "xoxa-1111111111-aaaaaaaaaa"`,
      ];
      for (const ex of examples) {
        const out = scrubSecrets(ex);
        expect(out).toContain("<redacted>");
        expect(out).not.toMatch(/abcdefghijk|zyxwvutsrqp|aaaaaaaaaa/);
      }
    });

    it("redacts AWS access-key-shaped values", () => {
      const out = scrubSecrets("got AKIAIOSFODNN7EXAMPLE");
      expect(out).toContain("<redacted>");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("redacts JWT-shaped values", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const out = scrubSecrets(`got token ${jwt}`);
      expect(out).toContain("<redacted>");
      expect(out).not.toContain(jwt);
    });

    it("redacts a generic 32+ char high-entropy run", () => {
      // 40 base64url chars
      const high = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0";
      const out = scrubSecrets(`got "${high}"`);
      expect(out).toContain("<redacted>");
      expect(out).not.toContain(high);
    });

    it("leaves natural-language Zod messages alone", () => {
      const message = "String must contain at least 32 character(s)";
      expect(scrubSecrets(message)).toBe(message);
    });

    it("leaves short non-secret messages alone", () => {
      const messages = [
        "required",
        "must be number",
        "expected an email address",
        "exactly 7 chars",
      ];
      for (const m of messages) expect(scrubSecrets(m)).toBe(m);
    });

    it("plays nicely with the default failure path — issue messages are redacted before logging", () => {
      const schema = makeSchema<{ X: string }>(() => ({
        success: false,
        issues: [
          {
            path: ["X"],
            message: `expected sk- prefix, got "sk-test_DEADBEEFCAFEBABE_1234567890"`,
            code: "custom",
          },
        ],
      }));
      const errorSpy = vi.fn();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);
      try {
        expect(() => defineEnv(schema, { source: {}, logger: { error: errorSpy } })).toThrow(
          "exit:1",
        );
        const lines = errorSpy.mock.calls.map((c) => c[0]).join("\n");
        expect(lines).toContain("<redacted>");
        expect(lines).not.toContain("DEADBEEFCAFEBABE");
      } finally {
        exitSpy.mockRestore();
      }
    });
  });

  it("uses process.env when no source is provided", () => {
    const schema = makeSchema<{ NODE_ENV: string }>((data) => {
      const env = data as Record<string, string | undefined>;
      return typeof env.NODE_ENV === "string"
        ? { success: true, data: { NODE_ENV: env.NODE_ENV } }
        : { success: false, issues: [{ path: ["NODE_ENV"], message: "required" }] };
    });

    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "test-fixture";
    try {
      expect(defineEnv(schema)).toEqual({ NODE_ENV: "test-fixture" });
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});
