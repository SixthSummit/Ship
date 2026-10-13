import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LLMProvider } from "../adapters/LLMProvider.js";
import type { CompleteOptions, CompleteResult, StreamEvent, ToolDefinition } from "../types.js";
import { completeStructured, StructuredOutputError } from "./completeStructured.js";

function buildProvider(response: CompleteResult): {
  llm: LLMProvider;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_opts: CompleteOptions) => response);
  return {
    llm: {
      name: "stub",
      complete: spy as unknown as LLMProvider["complete"],
      async *streamComplete(): AsyncIterable<StreamEvent> {
        // not used
      },
    },
    spy,
  };
}

const baseUsage = { inputTokens: 10, outputTokens: 5 };

describe("completeStructured", () => {
  it("forces a synthetic 'respond' tool with toolChoice → schema-derived inputSchema", async () => {
    const schema = z.object({
      city: z.string(),
      tempC: z.number(),
    });

    const { llm, spy } = buildProvider({
      id: "x",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "respond",
          input: { city: "Paris", tempC: 22 },
        },
      ],
      text: "",
      stopReason: "tool_use",
      usage: baseUsage,
    });

    const result = await completeStructured({
      llm,
      schema,
      model: "claude-test",
      messages: [{ role: "user", content: "weather in Paris?" }],
    });

    expect(result.data).toEqual({ city: "Paris", tempC: 22 });
    expect(result.raw.id).toBe("x");
    expect(spy).toHaveBeenCalledOnce();
    const opts = spy.mock.calls[0][0] as CompleteOptions;
    expect(opts.tools).toHaveLength(1);
    const tool = opts.tools![0] as ToolDefinition;
    expect(tool.name).toBe("respond");
    expect(tool.inputSchema.type).toBe("object");
    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.city.type).toBe("string");
    expect(props.tempC.type).toBe("number");
    expect(opts.toolChoice).toEqual({ type: "tool", name: "respond" });
  });

  it("respects custom responseToolName + description", async () => {
    const { llm, spy } = buildProvider({
      id: "x",
      model: "test",
      content: [
        {
          type: "tool_use",
          id: "tu",
          name: "give_answer",
          input: { ok: true },
        },
      ],
      text: "",
      stopReason: "tool_use",
      usage: baseUsage,
    });

    await completeStructured({
      llm,
      schema: z.object({ ok: z.boolean() }),
      model: "test",
      messages: [{ role: "user", content: "?" }],
      responseToolName: "give_answer",
      responseToolDescription: "Hand back the boolean",
    });

    const tool = (spy.mock.calls[0][0] as CompleteOptions).tools![0];
    expect(tool.name).toBe("give_answer");
    expect(tool.description).toBe("Hand back the boolean");
  });

  it("re-validates with Zod so refinements not in JSON Schema still apply", async () => {
    const schema = z.object({
      email: z.string().refine((v) => v.includes("@"), { message: "must contain @" }),
    });

    const { llm } = buildProvider({
      id: "x",
      model: "test",
      content: [
        {
          type: "tool_use",
          id: "tu",
          name: "respond",
          input: { email: "no-at-sign" },
        },
      ],
      text: "",
      stopReason: "tool_use",
      usage: baseUsage,
    });

    await expect(
      completeStructured({
        llm,
        schema,
        model: "test",
        messages: [{ role: "user", content: "?" }],
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);

    await expect(
      completeStructured({
        llm,
        schema,
        model: "test",
        messages: [{ role: "user", content: "?" }],
      }),
    ).rejects.toThrow(/email/);
  });

  it("throws StructuredOutputError when the model returns text only (no tool_use)", async () => {
    const { llm } = buildProvider({
      id: "x",
      model: "test",
      content: [{ type: "text", text: "I'd rather not call a tool." }],
      text: "I'd rather not call a tool.",
      stopReason: "end_turn",
      usage: baseUsage,
    });

    await expect(
      completeStructured({
        llm,
        schema: z.object({ x: z.number() }),
        model: "test",
        messages: [{ role: "user", content: "?" }],
      }),
    ).rejects.toMatchObject({
      name: "StructuredOutputError",
      raw: expect.objectContaining({ stopReason: "end_turn" }),
    });
  });

  it("forwards system/maxTokens/temperature/signal but strips llm/schema/tool* keys", async () => {
    const { llm, spy } = buildProvider({
      id: "x",
      model: "test",
      content: [
        {
          type: "tool_use",
          id: "tu",
          name: "respond",
          input: { ok: true },
        },
      ],
      text: "",
      stopReason: "tool_use",
      usage: baseUsage,
    });
    const ac = new AbortController();

    await completeStructured({
      llm,
      schema: z.object({ ok: z.boolean() }),
      model: "test",
      system: "be precise",
      maxTokens: 256,
      temperature: 0,
      signal: ac.signal,
      messages: [{ role: "user", content: "?" }],
    });

    const opts = spy.mock.calls[0][0] as CompleteOptions & {
      llm?: unknown;
      schema?: unknown;
    };
    expect(opts.system).toBe("be precise");
    expect(opts.maxTokens).toBe(256);
    expect(opts.temperature).toBe(0);
    expect(opts.signal).toBe(ac.signal);
    // Internal keys should not leak into the provider request.
    expect(opts.llm).toBeUndefined();
    expect(opts.schema).toBeUndefined();
  });

  it("returns the raw provider result alongside parsed data (usage / id pass-through)", async () => {
    const usage = {
      inputTokens: 50,
      outputTokens: 12,
      cacheReadInputTokens: 30,
    };
    const { llm } = buildProvider({
      id: "msg_42",
      model: "claude-opus-4-7",
      content: [
        {
          type: "tool_use",
          id: "tu",
          name: "respond",
          input: { value: "hi" },
        },
      ],
      text: "",
      stopReason: "tool_use",
      usage,
    });

    const out = await completeStructured({
      llm,
      schema: z.object({ value: z.string() }),
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "?" }],
    });

    expect(out.raw.id).toBe("msg_42");
    expect(out.raw.usage).toEqual(usage);
    expect(out.data).toEqual({ value: "hi" });
  });
});
