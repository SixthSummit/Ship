import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LLMProvider } from "../adapters/LLMProvider.js";
import { defineTool, toolRegistry } from "../tools/defineTool.js";
import type { CompleteOptions, CompleteResult, MessageContentPart, StreamEvent } from "../types.js";
import {
  type AgentEvent,
  AgentLoopMaxIterationsError,
  agentLoop,
  collectAssistantText,
} from "./agentLoop.js";

/**
 * Build a queue-driven LLM stub: each call to `complete()` shifts the
 * next response off the queue. Drives the loop deterministically.
 */
function queueLLM(responses: CompleteResult[]): {
  llm: LLMProvider;
  spy: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const spy = vi.fn(async (_opts: CompleteOptions) => {
    const next = queue.shift();
    if (!next) throw new Error("queueLLM: no more responses queued");
    return next;
  });
  return {
    llm: {
      name: "queue",
      complete: spy as unknown as LLMProvider["complete"],
      async *streamComplete(): AsyncIterable<StreamEvent> {
        // not used
      },
    },
    spy,
  };
}

function textResponse(text: string, idSuffix = "1"): CompleteResult {
  return {
    id: `msg_${idSuffix}`,
    model: "claude-test",
    content: [{ type: "text", text }],
    text,
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function toolCallResponse(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  precedingText?: string,
  idSuffix = "1",
): CompleteResult {
  const content: MessageContentPart[] = [];
  if (precedingText) content.push({ type: "text", text: precedingText });
  for (const c of calls) {
    content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  return {
    id: `msg_${idSuffix}`,
    model: "claude-test",
    content,
    text: precedingText ?? "",
    stopReason: "tool_use",
    usage: { inputTokens: 12, outputTokens: 6 },
  };
}

describe("agentLoop", () => {
  it("runs a single iteration when the model returns end_turn immediately", async () => {
    const { llm, spy } = queueLLM([textResponse("just a plain answer")]);

    const result = await agentLoop({
      llm,
      messages: [{ role: "user", content: "hello" }],
      model: "claude-test",
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(result.iterations).toBe(1);
    expect(result.finalText).toBe("just a plain answer");
    expect(result.totalUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
    // Final assistant turn appended to history.
    expect(result.history).toHaveLength(2);
    expect(result.history[1].role).toBe("assistant");
  });

  it("dispatches tool calls and feeds results back to the model", async () => {
    const weather = defineTool({
      name: "get_weather",
      description: "x",
      schema: z.object({ city: z.string() }),
      handler: ({ city }) => ({ tempC: 22, city }),
    });
    const tools = toolRegistry(weather);

    const { llm, spy } = queueLLM([
      toolCallResponse(
        [{ id: "tu_1", name: "get_weather", input: { city: "Paris" } }],
        "Let me check.",
        "1",
      ),
      textResponse("It's 22°C in Paris.", "2"),
    ]);

    const result = await agentLoop({
      llm,
      tools,
      messages: [{ role: "user", content: "weather in Paris?" }],
      model: "claude-test",
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.iterations).toBe(2);
    expect(result.finalText).toBe("It's 22°C in Paris.");

    // Iteration 2 must see the tool_result we appended.
    const secondCallMessages = (spy.mock.calls[1][0] as CompleteOptions).messages;
    const lastUser = secondCallMessages[secondCallMessages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const part = (lastUser.content as MessageContentPart[])[0];
    expect(part.type).toBe("tool_result");
    if (part.type === "tool_result") {
      expect(part.toolUseId).toBe("tu_1");
      expect(part.content).toBe('{"tempC":22,"city":"Paris"}');
      expect(part.isError).toBeFalsy();
    }

    // Total usage accumulates.
    expect(result.totalUsage.inputTokens).toBe(22);
    expect(result.totalUsage.outputTokens).toBe(11);
  });

  it("handles multiple parallel tool calls in a single assistant turn", async () => {
    const a = defineTool({
      name: "tool_a",
      description: "x",
      schema: z.object({ n: z.number() }),
      handler: ({ n }) => n * 2,
    });
    const b = defineTool({
      name: "tool_b",
      description: "x",
      schema: z.object({ s: z.string() }),
      handler: ({ s }) => s.toUpperCase(),
    });
    const tools = toolRegistry(a, b);

    const { llm, spy } = queueLLM([
      toolCallResponse(
        [
          { id: "tu_a", name: "tool_a", input: { n: 5 } },
          { id: "tu_b", name: "tool_b", input: { s: "hi" } },
        ],
        undefined,
        "1",
      ),
      textResponse("done", "2"),
    ]);

    const result = await agentLoop({
      llm,
      tools,
      messages: [{ role: "user", content: "do both" }],
      model: "claude-test",
    });

    expect(result.iterations).toBe(2);
    const secondCallMessages = (spy.mock.calls[1][0] as CompleteOptions).messages;
    const userMessage = secondCallMessages[secondCallMessages.length - 1];
    const parts = userMessage.content as MessageContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("tool_result");
    expect(parts[1].type).toBe("tool_result");
    if (parts[0].type === "tool_result" && parts[1].type === "tool_result") {
      expect(parts[0].toolUseId).toBe("tu_a");
      expect(parts[0].content).toBe("10");
      expect(parts[1].toolUseId).toBe("tu_b");
      expect(parts[1].content).toBe("HI");
    }
  });

  it("captures tool errors as isError tool_results — loop survives", async () => {
    const flaky = defineTool({
      name: "flaky",
      description: "x",
      schema: z.object({}),
      handler: () => {
        throw new Error("upstream 500");
      },
    });
    const tools = toolRegistry(flaky);

    const { llm } = queueLLM([
      toolCallResponse([{ id: "tu_x", name: "flaky", input: {} }]),
      textResponse("retried, gave up", "2"),
    ]);

    const result = await agentLoop({
      llm,
      tools,
      messages: [{ role: "user", content: "do it" }],
      model: "claude-test",
    });

    expect(result.iterations).toBe(2);
    expect(result.finalText).toBe("retried, gave up");

    // Find the user message containing tool_result.
    const userToolMsg = result.history.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "tool_result"),
    );
    expect(userToolMsg).toBeDefined();
    const parts = userToolMsg!.content as MessageContentPart[];
    const tr = parts[0];
    expect(tr.type).toBe("tool_result");
    if (tr.type === "tool_result") {
      expect(tr.isError).toBe(true);
      expect(tr.content).toContain("upstream 500");
    }
  });

  it("captures unknown tool names as isError tool_results", async () => {
    const tools = toolRegistry(); // empty registry

    const { llm } = queueLLM([
      toolCallResponse([{ id: "tu_x", name: "ghost", input: {} }]),
      textResponse("ok no tool", "2"),
    ]);

    const result = await agentLoop({
      llm,
      tools,
      messages: [{ role: "user", content: "x" }],
      model: "claude-test",
    });

    const userToolMsg = result.history.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === "tool_result"),
    )!;
    const tr = (userToolMsg.content as MessageContentPart[])[0];
    if (tr.type === "tool_result") {
      expect(tr.isError).toBe(true);
      expect(tr.content).toContain("ghost");
      expect(tr.content).toContain("not registered");
    }
  });

  it("throws AgentLoopMaxIterationsError when budget is exhausted", async () => {
    const tool = defineTool({
      name: "spin",
      description: "x",
      schema: z.object({}),
      handler: () => "more",
    });
    const tools = toolRegistry(tool);

    // Always return tool_use → loop never terminates.
    const responses: CompleteResult[] = Array.from({ length: 5 }).map((_, i) =>
      toolCallResponse([{ id: `tu_${i}`, name: "spin", input: {} }], undefined, String(i)),
    );
    const { llm } = queueLLM(responses);

    await expect(
      agentLoop({
        llm,
        tools,
        messages: [{ role: "user", content: "go" }],
        model: "claude-test",
        maxIterations: 3,
      }),
    ).rejects.toBeInstanceOf(AgentLoopMaxIterationsError);
  });

  it("forwards system/maxTokens/temperature/signal to llm.complete", async () => {
    const { llm, spy } = queueLLM([textResponse("ok")]);
    const ac = new AbortController();

    await agentLoop({
      llm,
      messages: [{ role: "user", content: "x" }],
      model: "claude-test",
      system: "be brief",
      maxTokens: 256,
      temperature: 0.1,
      signal: ac.signal,
    });

    const opts = spy.mock.calls[0][0] as CompleteOptions;
    expect(opts.system).toBe("be brief");
    expect(opts.maxTokens).toBe(256);
    expect(opts.temperature).toBe(0.1);
    expect(opts.signal).toBe(ac.signal);
  });

  it("emits lifecycle events in the documented order", async () => {
    const tool = defineTool({
      name: "echo",
      description: "x",
      schema: z.object({ s: z.string() }),
      handler: ({ s }) => s,
    });
    const tools = toolRegistry(tool);

    const { llm } = queueLLM([
      toolCallResponse([{ id: "tu_1", name: "echo", input: { s: "hi" } }]),
      textResponse("done", "2"),
    ]);

    const events: AgentEvent[] = [];
    await agentLoop({
      llm,
      tools,
      messages: [{ role: "user", content: "x" }],
      model: "claude-test",
      onEvent: (e) => {
        events.push(e);
      },
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "iteration_start",
      "model_response",
      "tool_call",
      "tool_result",
      "iteration_end",
      "iteration_start",
      "model_response",
      "iteration_end",
      "complete",
    ]);

    const completeEvent = events.find((e) => e.type === "complete");
    expect(completeEvent).toMatchObject({
      type: "complete",
      finalText: "done",
      iterations: 2,
    });
  });

  it("awaits async onEvent callbacks (backpressure)", async () => {
    const order: string[] = [];
    const { llm } = queueLLM([textResponse("ok")]);

    await agentLoop({
      llm,
      messages: [{ role: "user", content: "x" }],
      model: "claude-test",
      onEvent: async (e) => {
        if (e.type === "model_response") {
          await new Promise<void>((resolve) => setImmediate(resolve));
          order.push("after-await");
        } else {
          order.push(e.type);
        }
      },
    });

    expect(order).toEqual(["iteration_start", "after-await", "iteration_end", "complete"]);
  });

  it("forwards toolMetadata to each tool handler's ctx.metadata", async () => {
    let receivedMetadata: Record<string, unknown> | undefined;
    const tool = defineTool({
      name: "echo",
      description: "x",
      schema: z.object({}),
      handler: (_input, ctx) => {
        receivedMetadata = ctx.metadata;
        return "ok";
      },
    });
    const tools = toolRegistry(tool);

    const { llm } = queueLLM([
      toolCallResponse([{ id: "tu_1", name: "echo", input: {} }]),
      textResponse("done", "2"),
    ]);

    await agentLoop({
      llm,
      tools,
      messages: [{ role: "user", content: "x" }],
      model: "claude-test",
      toolMetadata: { requestId: "req_42", userId: "u_1" },
    });

    expect(receivedMetadata).toEqual({ requestId: "req_42", userId: "u_1" });
  });

  it("does not pass tools/toolChoice when registry is empty", async () => {
    const { llm, spy } = queueLLM([textResponse("ok")]);

    await agentLoop({
      llm,
      messages: [{ role: "user", content: "x" }],
      model: "claude-test",
    });

    const opts = spy.mock.calls[0][0] as CompleteOptions;
    expect(opts.tools).toBeUndefined();
    expect(opts.toolChoice).toBeUndefined();
  });

  it("treats stopReason=tool_use with zero tool_use blocks as terminal", async () => {
    // Edge case: provider emits stop_reason="tool_use" but content has
    // no tool_use parts. We treat as terminal to avoid infinite loop.
    const weirdResponse: CompleteResult = {
      id: "msg_weird",
      model: "claude-test",
      content: [{ type: "text", text: "almost called a tool" }],
      text: "almost called a tool",
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 3 },
    };
    const { llm } = queueLLM([weirdResponse]);

    const result = await agentLoop({
      llm,
      messages: [{ role: "user", content: "x" }],
      model: "claude-test",
    });
    expect(result.iterations).toBe(1);
    expect(result.finalText).toBe("almost called a tool");
  });

  it("respects pre-set abort signal", async () => {
    const { llm } = queueLLM([textResponse("never reached")]);
    const ac = new AbortController();
    ac.abort();

    await expect(
      agentLoop({
        llm,
        messages: [{ role: "user", content: "x" }],
        model: "claude-test",
        signal: ac.signal,
      }),
    ).rejects.toThrow(/Aborted/);
  });
});

describe("collectAssistantText", () => {
  it("flattens text across multiple assistant turns", () => {
    const history = [
      { role: "user" as const, content: "x" },
      { role: "assistant" as const, content: "first" },
      { role: "user" as const, content: "y" },
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "second " },
          { type: "tool_use", id: "tu", name: "x", input: {} },
          { type: "text", text: "part" },
        ] as MessageContentPart[],
      },
    ];
    expect(collectAssistantText(history)).toEqual(["first", "second part"]);
  });
});
