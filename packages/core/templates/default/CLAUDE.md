# {{PROJECT_NAME}}

A ShipAPI v4 application — TypeScript backend on Hono + Drizzle + pluggable AuthProvider + BullMQ + OpenTelemetry. The framework is your dependency at `node_modules/@sixthsummit/ship-api/`; you write modules, schemas, routes, jobs, and tests against its primitives.

## Agent onboarding

Read `AGENTS.md` first — it covers what this app is, where things live, how to run/test/build, the canonical "add a feature" flow, common agent mistakes, and how to verify your work. The rules in `.cursor/rules/` (also `@`-imported below) are the canonical conventions; AGENTS.md is the entry-point that points at them.

@AGENTS.md

## Project rules

@.cursor/rules/api.mdc
@.cursor/rules/typescript.mdc
@.cursor/rules/testing.mdc
@.cursor/rules/security.mdc
@.cursor/rules/commits.mdc
