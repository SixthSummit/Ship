import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool, ToolRegistry, toolRegistry } from "./defineTool.js";

describe("defineTool", () => {
  it("builds a JSON Schema definition from a Zod object schema", () => {
    const tool = defineTool({
      name: "get_weather",
      description: "Look up current weather for a city",
      schema: z.object({
        city: z.string(),
        unit: z.enum(["c", "f"]).optional(),
      }),
      handler: () => ({ tempC: 21 }),
    });

    expect(tool.name).toBe("get_weather");
    expect(tool.description).toBe("Look up current weather for a city");
    expect(tool.definition.name).toBe("get_weather");
    expect(tool.definition.inputSchema.type).toBe("object");
    const properties = tool.definition.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.city.type).toBe("string");
    expect(properties.unit.enum).toEqual(["c", "f"]);
    // Provider adapters don't expect $schema; verify we strip it.
    expect(tool.definition.inputSchema).not.toHaveProperty("$schema");
  });

  it("handler receives parsed input typed via z.infer", async () => {
    let received: { city: string; unit?: "c" | "f" } | undefined;
    const tool = defineTool({
      name: "get_weather",
      description: "x",
      schema: z.object({
        city: z.string(),
        unit: z.enum(["c", "f"]).optional(),
      }),
      handler: (input) => {
        received = input;
        return { tempC: 22 };
      },
    });

    const result = await tool.execute({ city: "Paris", unit: "c" }, {});
    expect(result).toEqual({ ok: true, output: { tempC: 22 } });
    expect(received).toEqual({ city: "Paris", unit: "c" });
  });

  it("rejects extra keys when strict (default)", async () => {
    const tool = defineTool({
      name: "lookup",
      description: "x",
      schema: z
        .object({
          id: z.string(),
        })
        .strict(),
      handler: () => null,
    });

    const result = await tool.execute({ id: "1", extra: true }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/extra/i);
    }
  });

  it("returns an error tool_result on schema mismatch (no throw)", async () => {
    const tool = defineTool({
      name: "lookup",
      description: "x",
      schema: z.object({ id: z.string() }),
      handler: () => null,
    });

    const result = await tool.execute({ id: 42 }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain("id");
    }
  });

  it("returns an error tool_result when the handler throws (loop survives)", async () => {
    const tool = defineTool({
      name: "lookup",
      description: "x",
      schema: z.object({ id: z.string() }),
      handler: () => {
        throw new Error("boom");
      },
    });

    const result = await tool.execute({ id: "1" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain("boom");
      expect(result.content).toContain("lookup");
    }
  });

  it("forwards ctx (signal + metadata) to the handler", async () => {
    const ac = new AbortController();
    const handler = vi.fn(() => "ok");
    const tool = defineTool({
      name: "x",
      description: "x",
      schema: z.object({}),
      handler,
    });

    await tool.execute({}, { signal: ac.signal, metadata: { requestId: "req_1" } });

    expect(handler).toHaveBeenCalledOnce();
    const ctx = handler.mock.calls[0][1];
    expect(ctx.signal).toBe(ac.signal);
    expect(ctx.metadata).toEqual({ requestId: "req_1" });
  });

  it("strict: false coerces null/undefined input through the schema", async () => {
    const tool = defineTool({
      name: "lookup",
      description: "x",
      schema: z.object({ id: z.string().optional() }),
      handler: (input) => input,
      strict: false,
    });

    const result = await tool.execute(undefined, {});
    expect(result).toEqual({ ok: true, output: {} });
  });
});

describe("ToolRegistry", () => {
  it("rejects duplicate tool names", () => {
    const t1 = defineTool({
      name: "x",
      description: "a",
      schema: z.object({}),
      handler: () => null,
    });
    const t2 = defineTool({
      name: "x",
      description: "b",
      schema: z.object({}),
      handler: () => null,
    });
    const registry = new ToolRegistry([t1]);
    expect(() => registry.add(t2)).toThrow(/duplicate/i);
  });

  it("has / lookup / size / list", () => {
    const t1 = defineTool({
      name: "a",
      description: "x",
      schema: z.object({}),
      handler: () => null,
    });
    const t2 = defineTool({
      name: "b",
      description: "x",
      schema: z.object({}),
      handler: () => null,
    });
    const registry = toolRegistry(t1, t2);
    expect(registry.size()).toBe(2);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.lookup("b")).toBe(t2);
    expect(registry.list().map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("getDefinitions() returns the JSON-schema views in registration order", () => {
    const a = defineTool({
      name: "a",
      description: "first",
      schema: z.object({ x: z.string() }),
      handler: () => null,
    });
    const b = defineTool({
      name: "b",
      description: "second",
      schema: z.object({ y: z.number() }),
      handler: () => null,
    });
    const registry = toolRegistry(a, b);
    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0]).toEqual({
      name: "a",
      description: "first",
      inputSchema: a.definition.inputSchema,
    });
    expect(defs[1].name).toBe("b");
  });
});
