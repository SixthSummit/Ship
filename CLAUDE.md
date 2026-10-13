# ship-api

TypeScript backend framework on Hono + Drizzle + pluggable AuthProvider + BullMQ + OpenTelemetry + Claude Code plugin. Currently `4.0.0-alpha.2` — the v4 line ships clean (no v3 paths in `main`). npm-workspaces monorepo: framework at `packages/core/` (published as `@sixthsummit/ship-api`), Claude Code plugin at `packages/claude-plugin/`, MCP server at `packages/mcp-server/`, feature modules under `modules/`, shared libraries under `libraries/`, Astro + Starlight docs site at `apps/docs/`. See `AGENTS.md` for the agent entry-point, `docs/V4_STATUS.md` for what's shipped / outstanding, and `docs/MIGRATION_V3_TO_V4.md` for consumer migration from v3.

## Agent onboarding

Read `AGENTS.md` first — it covers what this project is, where things live, how to run/test/build, the canonical "add a feature" flow, common agent mistakes, and how to verify your work. The rules in `.cursor/rules/` (also `@`-imported below) are the canonical conventions; AGENTS.md is the entry-point that points at them.

@AGENTS.md

## Project rules

The rules below are the canonical project guidelines. They are authored once in `.cursor/rules/` and shared between Cursor and Claude Code — **edit them there**, not here.

@.cursor/rules/project-patterns.mdc
@.cursor/rules/typescript.mdc
@.cursor/rules/api.mdc
@.cursor/rules/testing.mdc
@.cursor/rules/security.mdc
@.cursor/rules/commits.mdc
@.cursor/rules/template-development.mdc
