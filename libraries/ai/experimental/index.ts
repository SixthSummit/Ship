/**
 * `@sixthsummit/ship-api/libraries/ai/experimental` — surfaces that work but
 * carry **no stability promise** and may change or be removed in any release.
 *
 * `agentLoop` lives here (AI-R2): the hand-rolled model→tool→model loop is the
 * most volatile surface in the library — the ecosystem is moving to MCP /
 * provider-native agent runtimes, so this is the piece most likely to be
 * superseded. Durable code should prefer `completeStructured` (single-shot) or
 * call `llm.complete` directly. The loop's `defineTool` / `toolRegistry`
 * building blocks stay on the **stable** barrel — they're independently useful.
 */
export {
  type AgentEvent,
  AgentLoopError,
  AgentLoopMaxIterationsError,
  type AgentLoopOptions,
  type AgentLoopResult,
  agentLoop,
  collectAssistantText,
} from "../loop/agentLoop.js";
