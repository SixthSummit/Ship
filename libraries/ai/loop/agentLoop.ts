import type { LLMProvider } from "../adapters/LLMProvider.js";
import type { ToolContext, ToolRegistry } from "../tools/defineTool.js";
import type {
  CompleteResult,
  Message,
  MessageContentPart,
  StopReason,
  TokenUsage,
  ToolChoice,
  ToolResultPart,
  ToolUsePart,
} from "../types.js";

/**
 * `agentLoop({ llm, tools, messages, ... })` — runs the model →
 * tool-call → execute → continue cycle until the model returns
 * `end_turn` (or `max_tokens` / `content_filter`), or until
 * `maxIterations` is exceeded.
 *
 * Each iteration:
 *   1. Call `llm.complete` with the running history + tool definitions.
 *   2. If the response has `tool_use` content parts, execute each via
 *      the registry and append a `user` message containing the
 *      `tool_result` parts. Loop.
 *   3. Otherwise, return — the model is done.
 *
 * The `assistant` message we append to history preserves *every*
 * content part the model emitted (text + tool_use), in order, so the
 * provider sees a faithful turn record on the next request — Anthropic
 * (and OpenAI) require the assistant message to round-trip exactly so
 * the tool_use IDs align with the matching tool_result.
 *
 * Errors:
 *   - Tool handlers that throw → captured as `isError: true`
 *     `tool_result` so the model can recover. The loop survives.
 *   - Tool not found in the registry → also captured as
 *     `isError: true` with a clear message; the model adapts.
 *   - `maxIterations` exceeded → throws `AgentLoopMaxIterationsError`
 *     with the partial history attached for debugging.
 *   - `signal` aborts → SDK rejects, the throw propagates out of the
 *     loop without further iteration.
 *
 * Observability hook: `onEvent(event)` fires synchronously for each
 * lifecycle event. Consumers wire it to `streamSSE`, OTel spans,
 * prompt-eval logs — anything that wants per-step visibility. Awaited
 * if it returns a promise so callers can backpressure (e.g. SSE
 * write).
 *
 * @experimental — AI-R2. NOT on the stable API surface; carries no semver
 * stability promise and is expected to be superseded by MCP / provider-native
 * agent runtimes. Import from `@sixthsummit/ship-api/libraries/ai/experimental`.
 * Durable code should prefer `completeStructured` (single-shot) or call
 * `llm.complete` directly.
 */

export interface AgentLoopOptions {
  /** Provider that drives each iteration. */
  llm: LLMProvider;
  /** Tools the model can invoke. May be empty (degrades to plain `complete`). */
  tools?: ToolRegistry;
  /** Initial conversation history. The loop appends to a copy; the input is not mutated. */
  messages: Message[];
  /** Model identifier. Forwarded to `llm.complete` on every iteration. */
  model: string;
  /** Top-level system prompt. */
  system?: string;
  /**
   * Per-iteration `max_tokens` cap forwarded to `llm.complete`. Adapter
   * defaults apply when omitted.
   */
  maxTokens?: number;
  /** Sampling temperature forwarded to `llm.complete`. */
  temperature?: number;
  /** Tool-choice override. Defaults to `{ type: "auto" }` when tools are present. */
  toolChoice?: ToolChoice;
  /**
   * Provider-native passthrough forwarded to `llm.complete` on every
   * iteration (e.g. prompt caching, extended thinking). Without it the
   * seam's pass-through never reaches the adapter through the loop (AI-R1).
   */
  providerOptions?: Record<string, unknown>;
  /** Request-tagging forwarded to `llm.complete` for observability / cost tracking. */
  metadata?: Record<string, string>;
  /**
   * Maximum number of model→tool→model round-trips. The loop throws
   * `AgentLoopMaxIterationsError` if the model never returns
   * `end_turn` within this budget. Default 10.
   */
  maxIterations?: number;
  /** Cancels in-flight provider requests + tool handlers. */
  signal?: AbortSignal;
  /**
   * Forwarded to each tool handler's `ToolContext.metadata`. Typical
   * contents: `{ requestId, userId, tenantId }`. Caller-defined.
   */
  toolMetadata?: Record<string, unknown>;
  /** Lifecycle hook — see `AgentEvent` for event shapes. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export type AgentEvent =
  | { type: "iteration_start"; iteration: number; messages: Message[] }
  | { type: "model_response"; iteration: number; result: CompleteResult }
  | {
      type: "tool_call";
      iteration: number;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      iteration: number;
      toolUseId: string;
      name: string;
      ok: boolean;
      output?: unknown;
      error?: string;
    }
  | {
      type: "iteration_end";
      iteration: number;
      stopReason: StopReason;
    }
  | {
      type: "complete";
      finalText: string;
      iterations: number;
      totalUsage: TokenUsage;
    };

export interface AgentLoopResult {
  /** The terminal `complete()` response — i.e. the one with `stopReason !== "tool_use"`. */
  finalMessage: CompleteResult;
  /** Convenience: the final assistant text (already on `finalMessage.text`). */
  finalText: string;
  /** Number of model calls made (≥ 1). */
  iterations: number;
  /** Sum of input + output tokens across every iteration. */
  totalUsage: TokenUsage;
  /**
   * Full conversation history as the loop saw it after termination,
   * including all tool_use + tool_result content parts. Useful for
   * audit trails / tests.
   */
  history: Message[];
}

export class AgentLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLoopError";
  }
}

export class AgentLoopMaxIterationsError extends AgentLoopError {
  constructor(
    public readonly iterations: number,
    public readonly history: Message[],
  ) {
    super(`Agent loop exceeded maxIterations=${iterations} without reaching end_turn`);
    this.name = "AgentLoopMaxIterationsError";
  }
}

const DEFAULT_MAX_ITERATIONS = 10;

export async function agentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tools = opts.tools;
  const toolDefs = tools?.getDefinitions();
  const toolChoice =
    opts.toolChoice ?? (toolDefs && toolDefs.length > 0 ? { type: "auto" } : undefined);
  const onEvent = opts.onEvent ?? (() => undefined);

  const history: Message[] = [...opts.messages];
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (opts.signal?.aborted) {
      throw new AgentLoopError("Aborted before iteration " + iteration);
    }
    await onEvent({ type: "iteration_start", iteration, messages: history });

    const result = await opts.llm.complete({
      model: opts.model,
      // Defensive copy: the loop mutates `history` post-call by
      // appending the assistant turn + tool_results. Passing the live
      // reference would leak that mutation back into adapter retry
      // logic / test assertions on `mock.calls[].messages`.
      messages: [...history],
      system: opts.system,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      tools: toolDefs && toolDefs.length > 0 ? toolDefs : undefined,
      toolChoice,
      signal: opts.signal,
      providerOptions: opts.providerOptions,
      metadata: opts.metadata,
    });
    totalUsage = accumulateUsage(totalUsage, result.usage);
    await onEvent({ type: "model_response", iteration, result });

    if (result.stopReason !== "tool_use") {
      await onEvent({
        type: "iteration_end",
        iteration,
        stopReason: result.stopReason,
      });
      // Persist the final assistant turn so the returned history is
      // self-consistent (consumer can replay).
      history.push({ role: "assistant", content: result.content });
      await onEvent({
        type: "complete",
        finalText: result.text,
        iterations: iteration,
        totalUsage,
      });
      return {
        finalMessage: result,
        finalText: result.text,
        iterations: iteration,
        totalUsage,
        history,
      };
    }

    // Round-trip the assistant turn verbatim so tool_use IDs align with
    // the tool_result IDs the next user message carries.
    history.push({ role: "assistant", content: result.content });

    const toolUseParts = result.content.filter((p): p is ToolUsePart => p.type === "tool_use");
    if (toolUseParts.length === 0) {
      // Provider claimed `tool_use` but emitted no tool_use blocks —
      // treat as terminal to avoid infinite loop.
      await onEvent({
        type: "iteration_end",
        iteration,
        stopReason: "unknown",
      });
      await onEvent({
        type: "complete",
        finalText: result.text,
        iterations: iteration,
        totalUsage,
      });
      return {
        finalMessage: result,
        finalText: result.text,
        iterations: iteration,
        totalUsage,
        history,
      };
    }

    const toolResults: ToolResultPart[] = [];
    for (const tu of toolUseParts) {
      await onEvent({
        type: "tool_call",
        iteration,
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
      });
      const tool = tools?.lookup(tu.name);
      if (!tool) {
        const error = `tool "${tu.name}" not registered`;
        toolResults.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: error,
          isError: true,
        });
        await onEvent({
          type: "tool_result",
          iteration,
          toolUseId: tu.id,
          name: tu.name,
          ok: false,
          error,
        });
        continue;
      }
      const ctx: ToolContext = {
        signal: opts.signal,
        metadata: opts.toolMetadata,
      };
      const exec = await tool.execute(tu.input, ctx);
      if (exec.ok) {
        toolResults.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: serializeToolOutput(exec.output),
        });
        await onEvent({
          type: "tool_result",
          iteration,
          toolUseId: tu.id,
          name: tu.name,
          ok: true,
          output: exec.output,
        });
      } else {
        toolResults.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: exec.content,
          isError: true,
        });
        await onEvent({
          type: "tool_result",
          iteration,
          toolUseId: tu.id,
          name: tu.name,
          ok: false,
          error: exec.content,
        });
      }
    }

    history.push({ role: "user", content: toolResults });
    await onEvent({
      type: "iteration_end",
      iteration,
      stopReason: "tool_use",
    });
  }

  throw new AgentLoopMaxIterationsError(maxIterations, history);
}

function accumulateUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: sumOpt(a.cacheReadInputTokens, b.cacheReadInputTokens) ?? undefined,
    cacheCreationInputTokens:
      sumOpt(a.cacheCreationInputTokens, b.cacheCreationInputTokens) ?? undefined,
  };
}

function sumOpt(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Helper for assertions / observability — flatten the assistant text
 * across every iteration in the history. Useful when you want the
 * model's full reasoning trace, not just the terminal response.
 */
export function collectAssistantText(history: Message[]): string[] {
  const out: string[] = [];
  for (const msg of history) {
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      out.push(msg.content);
    } else {
      const text = (msg.content as MessageContentPart[])
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text) out.push(text);
    }
  }
  return out;
}
