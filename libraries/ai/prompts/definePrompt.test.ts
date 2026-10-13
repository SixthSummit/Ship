import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  definePrompt,
  PromptError,
  PromptRegistry,
  PromptRenderError,
  PromptValidationError,
  promptRegistry,
} from "./definePrompt.js";

describe("definePrompt", () => {
  it("substitutes {{name}} placeholders against typed inputs", () => {
    const prompt = definePrompt({
      id: "greet",
      version: 1,
      template: "Hello, {{name}}! Today is {{day}}.",
      schema: z.object({ name: z.string(), day: z.string() }),
    });

    const out = prompt.render({ name: "Ada", day: "Wednesday" });
    expect(out).toBe("Hello, Ada! Today is Wednesday.");
  });

  it("tolerates whitespace in placeholders ({{ name }})", () => {
    const prompt = definePrompt({
      id: "greet",
      version: 1,
      template: "Hi {{ name }}",
      schema: z.object({ name: z.string() }),
    });
    expect(prompt.render({ name: "x" })).toBe("Hi x");
  });

  it("supports dotted-path placeholders for nested inputs", () => {
    const prompt = definePrompt({
      id: "user_card",
      version: 1,
      template: "Name: {{user.name}}, Age: {{user.age}}",
      schema: z.object({
        user: z.object({ name: z.string(), age: z.number() }),
      }),
    });
    expect(prompt.render({ user: { name: "Ada", age: 36 } })).toBe("Name: Ada, Age: 36");
  });

  it("escapes \\{{ as literal {{", () => {
    const prompt = definePrompt({
      id: "esc",
      version: 1,
      template: "Use \\{{x}} for substitution; here {{x}} is x.",
      schema: z.object({ x: z.string() }),
    });
    expect(prompt.render({ x: "VAL" })).toBe("Use {{x}} for substitution; here VAL is x.");
  });

  it("throws PromptValidationError when input fails the schema", () => {
    const prompt = definePrompt({
      id: "greet",
      version: 1,
      template: "Hi {{name}}",
      schema: z.object({ name: z.string() }),
    });
    expect(() => prompt.render({ name: 42 } as unknown as { name: string })).toThrow(
      PromptValidationError,
    );
  });

  it("throws PromptRenderError when a referenced placeholder is missing (no schema)", () => {
    const prompt = definePrompt({
      id: "greet",
      version: 1,
      template: "Hi {{name}}",
    });
    expect(() => prompt.render({} as { name: string })).toThrow(PromptRenderError);
    expect(() => prompt.render({} as { name: string })).toThrow(/name/);
  });

  it("stringifies object values via JSON for embedded structured context", () => {
    const prompt = definePrompt({
      id: "ctx",
      version: 1,
      template: "Context: {{data}}",
      schema: z.object({ data: z.unknown() }),
    });
    expect(prompt.render({ data: { a: 1, b: [2, 3] } })).toBe('Context: {"a":1,"b":[2,3]}');
  });

  it("renders booleans/numbers correctly", () => {
    const prompt = definePrompt({
      id: "flags",
      version: 1,
      template: "live={{live}} count={{count}}",
      schema: z.object({ live: z.boolean(), count: z.number() }),
    });
    expect(prompt.render({ live: true, count: 0 })).toBe("live=true count=0");
  });

  it("renders empty string for null/undefined values", () => {
    const prompt = definePrompt({
      id: "opt",
      version: 1,
      template: "x={{x}}",
      schema: z.object({ x: z.string().nullable() }),
    });
    expect(prompt.render({ x: null })).toBe("x=");
  });

  it("ids and versions are surfaced for observability join keys", () => {
    const prompt = definePrompt({
      id: "audit_summary",
      version: 7,
      template: "ok",
      description: "explains the audit log entry",
      metadata: { owner: "agents" },
    });
    expect(prompt.id).toBe("audit_summary");
    expect(prompt.version).toBe(7);
    expect(prompt.description).toBe("explains the audit log entry");
    expect(prompt.metadata).toEqual({ owner: "agents" });
  });
});

describe("PromptRegistry", () => {
  it("rejects re-registration of the same (id, version) pair", () => {
    const a = definePrompt({ id: "x", version: 1, template: "first" });
    const b = definePrompt({ id: "x", version: 1, template: "second" });
    const registry = new PromptRegistry([a]);
    expect(() => registry.add(b)).toThrow(PromptError);
    expect(() => registry.add(b)).toThrow(/forget to bump/);
  });

  it("allows multiple versions of the same id", () => {
    const v1 = definePrompt({ id: "x", version: 1, template: "old" });
    const v2 = definePrompt({ id: "x", version: 2, template: "new" });
    const registry = new PromptRegistry([v1, v2]);
    expect(registry.size()).toBe(2);
    expect(registry.versions("x")).toEqual([2, 1]);
  });

  it("get(id) returns the latest version", () => {
    const v1 = definePrompt({ id: "x", version: 1, template: "v1" });
    const v3 = definePrompt({ id: "x", version: 3, template: "v3" });
    const v2 = definePrompt({ id: "x", version: 2, template: "v2" });
    const registry = promptRegistry(v1, v3, v2);
    expect(registry.get("x")?.version).toBe(3);
    expect(registry.get("x")?.template).toBe("v3");
  });

  it("getVersion(id, version) returns the exact pin", () => {
    const v1 = definePrompt({ id: "x", version: 1, template: "v1" });
    const v2 = definePrompt({ id: "x", version: 2, template: "v2" });
    const registry = promptRegistry(v1, v2);
    expect(registry.getVersion("x", 1)?.template).toBe("v1");
    expect(registry.getVersion("x", 99)).toBeUndefined();
  });

  it("get / getVersion return undefined for unknown ids", () => {
    const registry = new PromptRegistry();
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.getVersion("missing", 1)).toBeUndefined();
  });

  it("ids() reflects all registered prompt ids", () => {
    const a = definePrompt({ id: "a", version: 1, template: "a" });
    const b = definePrompt({ id: "b", version: 1, template: "b" });
    const registry = promptRegistry(a, b);
    expect(registry.ids().sort()).toEqual(["a", "b"]);
  });
});
