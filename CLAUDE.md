# Ship

pnpm + Turborepo monorepo for ShipAPI and ShipAngular. ShipAPI is an operation kernel (`packages/kernel`, published as `@sixthsummit/ship-core`) with focused adapter and capability packages under `packages/` (Hono, Drizzle, contract, auth, jobs, realtime, webhooks, cache, storage, mail, console, rich text, schema lint, observability, testing, CLI); `packages/core` is the route-first `@sixthsummit/ship-api` compatibility distribution; `packages/angular` is `@sixthsummit/ship-angular`. Docs sites live in `apps/docs/` and `apps/angular-docs/`, projected from `docs/` and `angular/docs/`. See `AGENTS.md` for the package table and agent entry-point, `docs/V4_STATUS.md` for what's shipped, `docs/rearchitecture/decisions/` for the ADRs, and `docs/MIGRATION_V3_TO_V4.md` for consumer migration. Never put customer or product names in this public repository.

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
