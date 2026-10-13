import { z } from "zod";
import type { ToolDefinition } from "../types.js";

/**
 * `defineTool({ name, description, schema, handler })` — the load-bearing
 * primitive the agent loop dispatches against. Pairs a Zod schema (the
 * tool's input contract) with a typed handler that consumes the parsed
 * input.
 *
 * Why a factory instead of a class:
 *   - The handler's input type is inferred from the Zod schema via
 *     `z.infer<typeof schema>`. A factory carries the inferred type
 *     through naturally; class generics force the consumer to repeat
 *     the inference.
 *   - The factory produces a `Tool` value that satisfies both the
 *     `ToolDefinition` shape (what providers see) and an `execute`
 *     surface (what the agent loop calls), without any inheritance
 *     ceremony.
 *   - `definition` is computed once at registration time — the
 *     `zodToJsonSchema` call doesn't run per-invocation.
 *
 * The handler receives the parsed input, plus a `ToolContext` carrying
 * cancellation + caller metadata. Handlers MAY return any JSON-
 * serializable value; the agent loop stringifies the result back into
 * a `tool_result` content part. Throwing inside the handler short-
 * circuits with `isError: true` (visible to the model) — the loop
 * doesn't crash, it lets the model recover.
 *
 * Strictness: by default, schema parsing is strict (extra keys throw)
 * to catch model output drift early. Pass `strict: false` to switch
 * to lenient parsing if a provider tends to wrap or annotate fields.
 */

export interface ToolContext {
  /** Caller-supplied abort signal. Honored by long-running handlers. */
  signal?: AbortSignal;
  /**
   * Free-form caller metadata. The agent loop forwards what it was
   * called with — typical contents: `{ requestId, userId }`.
   */
  metadata?: Record<string, unknown>;
}

export type ToolHandler<TInput, TOutput = unknown> = (
  input: TInput,
  ctx: ToolContext,
) => TOutput | Promise<TOutput>;

export interface DefineToolOptions<TSchema extends z.ZodTypeAny, TOutput> {
  /** Stable name. Models reference tools by name; keep it snake_case. */
  name: string;
  /**
   * One-line description shown to the model. The model uses this to
   * decide *when* to call the tool — make it precise. Bad: "Get data."
   * Good: "Look up the current weather forecast for a single city."
   */
  description: string;
  /**
   * Zod schema for the tool's input. Object schemas are strongly
   * recommended (providers expect JSON Schema with `type: "object"`).
   */
  schema: TSchema;
  /**
   * Receives the parsed input + a `ToolContext`. Return value is
   * stringified back to the model as the tool result; throwing produces
   * an `isError: true` tool_result the model can see and recover from.
   */
  handler: ToolHandler<z.infer<TSchema>, TOutput>;
  /**
   * Strict parsing (extra keys throw). Default true — catches model
   * output drift early. Set false for permissive providers.
   */
  strict?: boolean;
}

export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TOutput = unknown> {
  name: string;
  description: string;
  schema: TSchema;
  /** JSON Schema view used by `LLMProvider` adapters. Built once at registration. */
  definition: ToolDefinition;
  /**
   * Run the tool with raw provider-supplied input. Validates against the
   * Zod schema first; on validation failure returns `{ ok: false,
   * isError: true, content }` with the Zod issue path so the model can
   * see what was wrong.
   *
   * On handler success: `{ ok: true, output }` with the raw return
   * value. The agent loop is responsible for serializing `output` for
   * the `tool_result` content part.
   *
   * On handler throw: `{ ok: false, isError: true, content }` with the
   * error message — *not* re-thrown, so the loop survives and the model
   * can decide whether to retry.
   */
  execute(input: unknown, ctx: ToolContext): Promise<ToolExecuteResult<TOutput>>;
}

export type ToolExecuteResult<TOutput> =
  | { ok: true; output: TOutput }
  | { ok: false; isError: true; content: string };

export function defineTool<TSchema extends z.ZodTypeAny, TOutput>(
  opts: DefineToolOptions<TSchema, TOutput>,
): Tool<TSchema, TOutput> {
  const inputSchema = z.toJSONSchema(opts.schema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  // Strip the $schema header so providers (which don't expect it) accept the schema.
  delete inputSchema["$schema"];

  const definition: ToolDefinition = {
    name: opts.name,
    description: opts.description,
    inputSchema,
  };

  const strict = opts.strict ?? true;

  return {
    name: opts.name,
    description: opts.description,
    schema: opts.schema,
    definition,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolExecuteResult<TOutput>> {
      const parsed = strict ? opts.schema.safeParse(input) : opts.schema.safeParse(input ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          isError: true,
          content: formatZodIssues(parsed.error.issues),
        };
      }
      try {
        const output = await opts.handler(parsed.data as z.infer<TSchema>, ctx);
        return { ok: true, output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? "unknown error");
        return {
          ok: false,
          isError: true,
          content: `tool "${opts.name}" failed: ${message}`,
        };
      }
    },
  };
}

interface ZodLikeIssue {
  path?: Array<string | number>;
  message: string;
}

function formatZodIssues(issues: readonly ZodLikeIssue[]): string {
  if (!issues.length) return "validation failed";
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * `ToolRegistry` — ordered map keyed by tool name, with lookup helpers
 * the agent loop needs (`getDefinitions()` for the provider request,
 * `lookup(name)` for dispatch). Constructible standalone (tests) or via
 * the convenience `toolRegistry(...tools)` factory.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<z.ZodTypeAny, unknown>>();

  constructor(tools: ReadonlyArray<Tool<z.ZodTypeAny, unknown>> = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: Tool<z.ZodTypeAny, unknown>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  lookup(name: string): Tool<z.ZodTypeAny, unknown> | undefined {
    return this.tools.get(name);
  }

  /** Tool definitions the agent loop attaches to provider requests. */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  size(): number {
    return this.tools.size;
  }

  list(): ReadonlyArray<Tool<z.ZodTypeAny, unknown>> {
    return Array.from(this.tools.values());
  }
}

export function toolRegistry(...tools: Array<Tool<z.ZodTypeAny, unknown>>): ToolRegistry {
  return new ToolRegistry(tools);
}
