import { z } from "zod";
import type { LLMProvider } from "../adapters/LLMProvider.js";
import type { CompleteOptions, CompleteResult, ToolDefinition, ToolUsePart } from "../types.js";

/**
 * `completeStructured<TSchema>({ llm, schema, ... })` — single-shot
 * call that returns a typed object matching the supplied Zod schema.
 *
 * Pattern: defines a synthetic "respond" tool whose `input_schema` is
 * the JSON-schema view of the user's Zod schema, forces
 * `tool_choice: { type: "tool", name }` so the model MUST invoke it,
 * then parses the tool_use input back through the Zod schema (catches
 * any drift the JSON-schema view didn't constrain — e.g. Zod
 * refinements that don't translate).
 *
 * Provider-portable by design — works against any `LLMProvider` whose
 * `complete()` honors `tools` + `toolChoice`. Provider-specific
 * structured-output APIs (OpenAI `response_format: json_schema`,
 * Anthropic `parse()` helper) can be wired in adapter-specific
 * overrides in a later commit; this primitive ships the load-bearing
 * cross-provider path first.
 *
 * Why a synthetic tool instead of "ask the model for JSON in a code
 * block":
 *   - Tool-use is the model's native structured-output channel —
 *     providers train it explicitly. JSON-in-text is best-effort and
 *     drifts (markdown fences, trailing commentary, hallucinated keys).
 *   - The tool's `input_schema` is forced upstream in the request, so
 *     the provider can constrain decoding (Anthropic does shape-aware
 *     decoding for tool inputs).
 *   - Tool inputs come back already-parsed JSON — no re-parsing /
 *     stripping markdown.
 *
 * Errors: `StructuredOutputError` thrown when (a) the model returns
 * text instead of invoking the tool (rare with `toolChoice: tool` but
 * possible on `max_tokens` cutoff), (b) the tool input fails Zod
 * validation. Both carry the raw `CompleteResult` for debugging.
 */

export interface CompleteStructuredOptions<TSchema extends z.ZodTypeAny>
  extends Omit<CompleteOptions, "tools" | "toolChoice"> {
  /** Provider that runs the request. */
  llm: LLMProvider;
  /** Zod schema describing the desired output shape. */
  schema: TSchema;
  /**
   * Override the synthetic tool's name. Default `"respond"`. Useful
   * when the tool name appears in the model's reasoning trace and you
   * want it to read more naturally.
   */
  responseToolName?: string;
  /** Override the synthetic tool's description shown to the model. */
  responseToolDescription?: string;
}

export interface CompleteStructuredResult<T> {
  /** The parsed, schema-validated output. */
  data: T;
  /** The raw provider response (usage / id / model / etc.). */
  raw: CompleteResult;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly raw: CompleteResult,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

const DEFAULT_TOOL_NAME = "respond";
const DEFAULT_TOOL_DESCRIPTION =
  "Respond with the structured output. Call this tool exactly once with the final answer matching the input schema.";

export async function completeStructured<TSchema extends z.ZodTypeAny>(
  opts: CompleteStructuredOptions<TSchema>,
): Promise<CompleteStructuredResult<z.infer<TSchema>>> {
  const inputSchema = z.toJSONSchema(opts.schema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  delete inputSchema["$schema"];

  const responseTool: ToolDefinition = {
    name: opts.responseToolName ?? DEFAULT_TOOL_NAME,
    description: opts.responseToolDescription ?? DEFAULT_TOOL_DESCRIPTION,
    inputSchema,
  };

  // Drop the keys we own from the forwarded options.
  const {
    llm,
    schema: _schema,
    responseToolName: _name,
    responseToolDescription: _desc,
    ...providerOpts
  } = opts;
  void _schema;
  void _name;
  void _desc;

  const raw = await llm.complete({
    ...providerOpts,
    tools: [responseTool],
    toolChoice: { type: "tool", name: responseTool.name },
  });

  const toolUse = raw.content.find(
    (p): p is ToolUsePart => p.type === "tool_use" && p.name === responseTool.name,
  );
  if (!toolUse) {
    throw new StructuredOutputError(
      `Model did not invoke the "${responseTool.name}" tool — got stop_reason="${raw.stopReason}"`,
      raw,
    );
  }

  const parsed = opts.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new StructuredOutputError(
      `Response did not match schema: ${formatZodIssues(parsed.error.issues)}`,
      raw,
    );
  }

  return { data: parsed.data as z.infer<TSchema>, raw };
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
