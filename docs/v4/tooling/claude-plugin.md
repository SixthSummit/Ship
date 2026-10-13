# Claude Code plugin

> **Optional compatibility tooling:** the plugin can help current v4 projects,
> but it is not a correctness dependency of the replacement architecture. New
> applications rely on compiled invariants and repository gates first.

`@sixthsummit/ship-api-claude-plugin` — four agents, seven slash commands, five skills, three hooks, and a bundled MCP server. Auto-loads when an agent is working in a ShipAPI repo. Why it exists, what each piece does, and how the pieces fit together.

## What it's for

Agents working in a ShipAPI repo have to know a lot of conventions: the seven-file module shape, the chained-app pattern, when to use `validate()` vs `c.req.json()` (never the latter), how to compose `requireAuth` + `requirePermission`, when to throw `AppError` subclasses vs return JSON, the never-edit-SQL-by-hand rule, the don't-enqueue-inside-transactions rule, and dozens more. Without help, agents drift — sometimes catastrophically (writing manual SQL into `migrations/*.sql` because the diff "looks small enough").

The plugin closes that gap five ways:

- **Agents** — specialists for design / scaffolding / review. Invoke them when the task fits.
- **Slash commands** — single-line workflows that orchestrate generators, hooks, and the MCP server.
- **Skills** — auto-loaded summaries of `.cursor/rules/*.mdc`. Always in context when working on the repo.
- **Hooks** — block obviously-wrong actions (editing migration SQL) and prompt review after risky ones.
- **MCP server** — runtime introspection so agents can ask "what routes exist?", "what's the schema for POST /accounts?", "does my body validate?" against the running dev server.

## Installation

The plugin is bundled with the framework. Once you've scaffolded a ShipAPI repo (`ship-api create`), Claude Code picks it up automatically — the plugin's `.mcp.json` lives in `packages/claude-plugin/` and Claude Code loads it for that working directory.

For non-ShipAPI repos that consume `@sixthsummit/ship-api`, the plugin loads from the consumer app's `node_modules`. There's nothing to install separately.

## Agents

Four specialists. Each ships with a frontmatter (`name`, `description`, `tools`, `color`) and a system prompt that scopes its responsibilities.

### `ship-architect`

| Field | Value |
| --- | --- |
| Tools | Read, Grep, Glob |
| Purpose | Design a module from a feature description before any code is written. |
| When to invoke | "Design a module for billing", "What should the schema look like?", "How would I structure this?" |
| Output | A markdown plan: schema columns, permissions, route table, validation, service surface. **Zero code.** |

The architect reads the canonical references (`modules/accounts/`, `modules/oauth/`, `modules/outbox/`) and decides:

- Entity boundaries — what belongs in this module vs adjacent ones
- Schema — column types, indexes, FK relationships
- Permissions — slug constants for each operation
- Route shape — REST or domain-shaped endpoints
- Validation — Zod schema outline
- Service surface — methods beyond inherited CRUD

It outputs a plan to be handed to `ship-codegen`. The split is deliberate — design and execution are different cognitive tasks; doing both in one agent loop tends to short-circuit the design.

### `ship-codegen`

| Field | Value |
| --- | --- |
| Tools | Read, Edit, Write, Bash, Grep, Glob |
| Purpose | Execute a `ship-architect` plan against the v4 substrate. |
| When to invoke | After a plan is approved: "Implement the billing module from this plan." |
| Output | A complete module: scaffold + customizations + tests + verification. |

The codegen agent's protocol:

1. Run `ship-api g module <name>` (or `g resource <name> --fields ...`) — never start blank.
2. Customize in canonical order: schema → permissions → validation → service → routes → tests.
3. Compose the schema via `createDb({ config, schema })` and mount the module's sub-app on the root via `root.route("/", buildXxxApp(deps))`.
4. Verify: `npm run type-check` → `npm run lint` → `npm test -w @sixthsummit/ship-api` → `npm run build -w @sixthsummit/ship-api` → `npm run check:skills`. Don't declare done until all pass.

The agent mirrors the structure of the canonical references — `accounts` for CRUD, `oauth` for non-CRUD verbs (multi-step flows), `outbox` for per-action permissions and transactional outbox patterns.

### `ship-reviewer`

| Field | Value |
| --- | --- |
| Tools | Read, Grep, Glob, Bash |
| Purpose | Audit a diff for v4 convention violations. |
| When to invoke | "Review my changes" / auto-fires after Edit/Write to module files (PostToolUse hook). |
| Output | A markdown table of violations, ordered by severity (blocking vs advisory). |

What the reviewer looks for, in priority order:

1. **`validate()` on every mutating route** — POST / PUT / PATCH / DELETE without `validate("json", schema)` is a violation. The convention exists because `c.req.json()` skips type-flow into the typed client.
2. **`requireAuth({ provider })` and `requirePermission(slug)`** — every protected route. Authorization at the route, not the handler.
3. **No raw `process.env`** outside `src/environment.ts`. Use `defineEnv()`.
4. **No `console.log`** in framework or module code. Use the framework's logger.
5. **No hand-edited migrations** in `src/db/migrations/*.sql`. PreToolUse hook normally catches this; the reviewer is the safety net for human-edited files.
6. **No BullMQ enqueues inside transactions.** Use the outbox pattern.
7. **`AppError` subclasses thrown, not response JSON shaped in handler.** `registerErrorHandlers` does the formatting.
8. **`.strict()` on object Zod schemas.** Surfaces typos in client requests.

The reviewer presents findings as a table. Clean diffs surface plainly: "no convention violations found." Blocking issues need to be fixed before merge; advisory issues are notes for the author.

### `qa-brief`

| Field | Value |
| --- | --- |
| Tools | Read, Grep, Glob, Bash |
| Purpose | Generate a Sherpa-ready QA brief from a backend diff. |
| When to invoke | Manually via `/ship:sherpa-brief`, or headless from the `sherpa-brief.yml` workflow on PR-to-`dev` / push-to-`dev`. |
| Output | A markdown brief with plain-English flows the QA pastes into Sherpa's `/explore`. **No code, no test scaffolding** — that's Sherpa's job after the flows are pasted. |

The agent walks the diff, enumerates new / changed routes, follows `requireAuth` + `requirePermission` chains, reads `validate()` schemas for sad-path inputs, and grabs `AppError` throws for domain sad paths. The brief is structured so QA can copy-paste single flows into Sherpa one at a time — no engineer admin work between merge and QA pickup. See [tooling/sherpa-qa-briefs](sherpa-qa-briefs.md) for the deep dive.

## Slash commands

Seven commands. Invoke from the Claude Code prompt with `/<name> <args>`.

| Command | Purpose | Args |
| --- | --- | --- |
| `/ship:lint-conventions` | Run `ship-reviewer` over branch changes vs `main`. | `[--diff \| --all]` |
| `/ship:new-module` | Design + scaffold a new module (chains `ship-architect` → `ship-codegen`). | `<feature description>` |
| `/ship:add-job` | Scaffold a BullMQ job via `ship-api g job`. | `<job-name> -m <module>` |
| `/ship:add-migration` | Generate a Drizzle migration via `npm run db:generate`. | `<migration-name>` |
| `/ship:add-cron` | Scaffold a `defineCron` file via `ship-api g cron`. | `<cron-name> -m <module>` |
| `/ship:trace-request` | Grep local pino logs for a request id, surface chronologically. | `<request-id>` |
| `/ship:sherpa-brief` | Run `qa-brief` over the branch diff and print a Sherpa-ready brief. Same output the `sherpa-brief.yml` workflow emits — previewed locally. | `[--base <ref>]` |

### `/ship:new-module`

The flagship workflow. Takes a feature description, runs `ship-architect` to produce a plan, presents it for approval, then runs `ship-codegen` to execute. One command does end-to-end module creation.

```
/ship:new-module billing — invoices, line items, payments. Stripe integration.
```

The architect outputs a plan; you review; you approve; the codegen runs. Or you redirect ("change the payments table to be a separate module") and iterate before committing to the implementation.

### `/ship:add-job`, `/ship:add-cron`

Convenience wrappers around `g job` and `g cron`. The slash command is shorter to type and includes the post-scaffolding guidance inline:

```
/ship:add-job send-welcome -m accounts
```

Surfaces the TODO `payloadSchema` and `processor` stub plus a reminder: "Never enqueue inside a database transaction. Use the outbox pattern via `OutboxEventEmitter.emit({...}, { tx })` if the enqueue must be atomic with the domain write."

### `/ship:add-migration`

Wraps `npm run db:generate -- --name <arg>`. Includes the post-generation guidance: review the SQL, apply locally with `npm run db:migrate`, verify in Drizzle Studio, run module tests. Reminds about the `block-migration-edit.sh` PreToolUse hook so editing the resulting `.sql` won't work — re-run the generator instead.

### `/ship:trace-request`

Operational helper. Greps the local pino log for `requestId === <arg>` and presents events chronologically:

```
/ship:trace-request 7f3a2e8b-0f4d-4a1d-9d80-1c0d8b9a4e2c
```

Surfaces auth events, permission checks, validation failures, domain-error throws, DB errors, and the OTel `trace_id` so you can pivot to your APM. Useful for the "user reports a bug, here's their request id" debugging flow.

### `/ship:sherpa-brief`

Local preview for the Sherpa QA handoff. Prints to the terminal what the `sherpa-brief.yml` workflow would post on the PR (and Slack on merge). Useful when you're shaping the PR description and want to see what QA will get before pushing.

```
/ship:sherpa-brief
/ship:sherpa-brief --base origin/main
```

Cursor users can't run this — the CI path covers them via the PR comment. See [tooling/sherpa-qa-briefs](sherpa-qa-briefs.md) for the full integration.

## Skills

Skills are auto-loaded summaries of `.cursor/rules/*.mdc`. Always in agent context when working on the repo. Five skills cover the canonical conventions:

| Skill | Source rules | Purpose |
| --- | --- | --- |
| `ship-api-conventions` | `.cursor/rules/api.mdc`, `typescript.mdc`, others | Master patterns: module shape, routes, auth, validation, errors, services, schema, permissions, env, logging, migrations. |
| `ship-module-pattern` | `.cursor/rules/project-patterns.mdc` | The seven-file module shape, dependency injection, route return-type, permission slug naming, validation strictness. |
| `ship-drizzle-migrations` | `.cursor/rules/api.mdc` (DB section) | Migration tools, the never-hand-edit-SQL rule, common flows (add column, rename, adopt v4 against v3). |
| `ship-bullmq-jobs` | Alpha-2 plan §E | Job module pattern, cron pattern, `WORKER_MODE`, outbox pattern, observability for jobs. |
| `ship-otel-debugging` | `.cursor/rules/api.mdc` (Observability) | OpenTelemetry patterns, request-id propagation, trace correlation. |

### Drift detection

Skills are derived from `.cursor/rules/*.mdc` via `npm run sync:skills`. The pinned rule hashes live in each `SKILL.md`'s frontmatter. The CI guard `npm run check:skills` fails if any rule changes without a corresponding `sync:skills` run — agents see the conventions in two places (Cursor reads `.mdc`; Claude Code plugin reads `SKILL.md`), and drift between them is treated as a release-blocker.

The split exists because Cursor and Claude Code load conventions through different mechanisms. `.cursor/rules/*.mdc` is the canonical authoring source; the SKILL.md files are derived. **Edit the rules, not the skills.** `sync:skills` propagates; CI catches if you forget.

## Hooks

Three event-triggered scripts. Live under `packages/claude-plugin/hooks/`.

### `block-migration-edit.sh` (PreToolUse)

Fires on Edit / Write to `src/db/migrations/*.sql`. Blocks the operation with stderr:

> v4 migrations are emitted by drizzle-kit generate from schema source. Hand-editing the SQL drifts from the generator. Edit the schema source instead, then `npm run db:generate`.

Exit code 2 (block). The agent can't bypass without explicit user override.

The hook exists because hand-edited migration SQL is a multi-day debug class — the generator runs again and the next migration's diff is wrong, but the failure surfaces three migrations later when something Drizzle expects to be present isn't. Catching at edit time prevents the entire failure mode.

### `maybe-review.sh` (PostToolUse)

Fires after Edit / Write to `modules/**/*.ts` or `packages/core/src/**/*.ts` (excluding test files). Emits a hint to the agent:

> ship-api PostToolUse: edited `<path>`. Consider invoking `ship-reviewer` subagent to check conventions before declaring done.

Doesn't block — just suggests. The agent typically follows up with a `ship-reviewer` invocation, which catches the convention violations the agent might have missed during the active edit.

### `stop-reminder.sh` (Stop)

Fires at session end if the transcript shows module edits. Reminds:

> ship-api Stop reminder: run `npm run type-check && npm run lint && npm test -w @sixthsummit/ship-api` before commit. Pre-commit hooks and CI run these; failing locally first saves the round-trip.

Idempotent per session — doesn't fire repeatedly within a session, only once at the end if relevant edits happened.

## MCP server

The plugin's `.mcp.json` registers the framework's MCP server:

```json
{
  "mcpServers": {
    "ship-api": {
      "command": "npx",
      "args": ["-y", "@sixthsummit/ship-api-mcp-server"],
      "env": { "SHIP_API_DEV_URL": "http://localhost:3000" }
    }
  }
}
```

Four tools: `list_routes`, `describe_route`, `find_route_collisions`, `execute_route`. The first three are read-only introspection; `execute_route` is the load-bearing differentiator — agents iterate against the real middleware chain instead of a static schema. See [tooling/mcp-server](mcp-server.md) for the deep dive.

The MCP server runs as a separate process — `npx` launches it on demand when Claude Code needs to call a tool. It connects to the running dev server (`SHIP_API_DEV_URL`, default `http://localhost:3000`) for route registry data and request execution. **The dev server has to be running** for the MCP tools to work; the plugin doesn't spawn one for you (that's `ship-api dev`'s job).

## Plugin architecture overview

```
packages/claude-plugin/
├── plugin.json                    # plugin metadata
├── .mcp.json                      # MCP server registration
├── agents/
│   ├── ship-architect.md
│   ├── ship-codegen.md
│   ├── ship-reviewer.md
│   └── qa-brief.md
├── commands/ship/
│   ├── lint-conventions.md
│   ├── new-module.md
│   ├── add-job.md
│   ├── add-migration.md
│   ├── add-cron.md
│   ├── trace-request.md
│   └── sherpa-brief.md
├── skills/
│   ├── ship-api-conventions/
│   │   └── SKILL.md
│   ├── ship-module-pattern/SKILL.md
│   ├── ship-drizzle-migrations/SKILL.md
│   ├── ship-bullmq-jobs/SKILL.md
│   └── ship-otel-debugging/SKILL.md
└── hooks/
    ├── block-migration-edit.sh
    ├── maybe-review.sh
    └── stop-reminder.sh
```

Each subdirectory follows Claude Code's plugin conventions. Frontmatter on agent / command / skill markdown files defines metadata; the body is the system prompt or instructional content.

## Operational concerns

**The plugin assumes `ship-api dev` is running.** Slash commands like `/ship:trace-request` need local pino logs; MCP tools need the dev server. If you run only the framework's tests without the dev server up, those tools won't work. Restart the dev server after long pauses.

**Skills auto-load on every relevant edit.** That's a feature (agents stay aligned with conventions) and a cost (extra context tokens). The skill content is curated to be concise; if it ever grows, the drift-detection CI guard surfaces during sync.

**Hooks fire even without explicit invocation, but they have different authority.** PreToolUse blocks the configured migration edit. PostToolUse only emits a hint; it does not invoke the reviewer or enforce its suggestions. Correctness must still come from code, tests, and CI.

**The reviewer agent isn't a replacement for human review.** It catches mechanical violations (missing middleware, raw env access, wrong error pattern). It doesn't catch architectural mistakes ("this should be three smaller modules", "this permission scope is wrong for the threat model"). Human review remains essential.

## Source

- [`packages/claude-plugin/`](https://github.com/sixthsummit/ship-api/tree/main/packages/claude-plugin) — the plugin source
- [`.cursor/rules/`](https://github.com/sixthsummit/ship-api/tree/main/.cursor/rules) — the canonical convention source (synced into SKILL.md)
- [tooling/mcp-server](mcp-server.md) — the four MCP tools
- [tooling/sherpa-qa-briefs](sherpa-qa-briefs.md) — the QA handoff agent + workflow
- [tooling/cli](cli.md) — the CLI commands several slash commands wrap
- [getting-started/agents](/getting-started/agents/) — the cross-tool AGENTS.md document the plugin's agents read first
