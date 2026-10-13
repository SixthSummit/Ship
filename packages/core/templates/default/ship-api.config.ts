/**
 * `ship-api.config.ts` — marker file the Claude Code plugin's
 * activation glob keys off (`**\/ship-api.config.ts`). When this
 * file is present at the workspace root, the plugin's agents,
 * slash commands, skills, and hooks become available; when it's
 * absent, the plugin stays dormant.
 *
 * Plugin-side configuration the framework does not own (custom
 * skill-trigger lists, project-specific agent prompts, hook
 * overrides) lives here. The framework's runtime config lives in
 * `src/environment.ts` (validated) and `src/index.ts`
 * (composition).
 */
export const config = {
  /** Plugin-readable hint for agent-driven workflows. */
  framework: "ship-api",
  /** Plugin-readable version pin so agents pick the right SKILL.md. */
  frameworkVersion: "4",
} as const;

export default config;
