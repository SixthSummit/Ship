# ADR-0020: Replace compatibility agent tooling with operation-oriented tools

- **Status:** Proposed
- **Date:** 2026-10-16
- **Scope:** MCP server and Claude Code plugin; not removal of the framework compatibility distribution
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md), [ADR-0009](./0009-client-safe-contract-projections.md), [ADR-0012](./0012-v4-replacement-and-release-boundary.md)

## Context

The current agent packages were built for the route-first compatibility distribution:

- `@sixthsummit/ship-api-mcp-server` reads `/dev/routes.json` and exposes `list_routes`, `describe_route`, `find_route_collisions`, and `execute_route`.
- `@sixthsummit/ship-api-claude-plugin` teaches compatibility module generators, `DrizzleEntityService`, route middleware access checks, and the Hono `hc` client. Its trace command assumes compatibility log fields and locations.
- The plugin's review hook emits a suggestion; it does not execute a review. Its root manifest also retains a stale version and ISC license, despite the package's Apache-2.0 license.

These are real implementations, but they do not establish support for the operation kernel. The kernel does not automatically expose the compatibility registry endpoint. Calling both architectures “v4” obscures this distinction.

The replacement already has concrete foundations:

| Existing implementation | Source | What it establishes |
| --- | --- | --- |
| Compiled application graph | `packages/kernel/src/application.ts` | Declared modules, operations, providers, access, transactions, effects, transport, jobs, channels, outboxes, and cache relationships |
| Graph tooling | `packages/cli/src/graph.js` | Application loading, compiler diagnostics, node inspection, permissions, and declared dependency impact |
| Contract projection | `packages/contract/src/manifest.ts`, `packages/contract/src/project.ts` | Client-safe schemas, errors, transport, and a contract fingerprint |
| Contract artifact generation | `packages/cli/src/contract.js` | Contract, TypeScript, and OpenAPI emission |
| Tested application examples | `fixtures/consumers/minimal`, `fixtures/consumers/customized` | Executable examples of supported architecture and adapter behavior |

The graph describes declarations. It cannot prove that a repository applies the correct tenant predicate, identify every file affected by an edit, report live job health, or establish deployed behavior. Client contracts intentionally exclude some internal surfaces, including inbound webhooks. The internal graph and the browser-safe contract serve different audiences.

## Direction

Build replacement tooling for the operation architecture only. Retain useful workflows, not the old implementation assumptions. Every advertised capability must have an executable acceptance case. This ADR is a design proposal; it does not claim that the replacement is implemented or released.

### One implementation of framework semantics

Keep the compiler and contract projector authoritative. Extract or reuse the CLI's application-loading, inspection, and impact functions behind a shared interface. The CLI and MCP must use the same results and diagnostics rather than maintain parallel graph traversal, policy inference, schema validation, or collision logic.

The MCP server is an agent-facing adapter. The Claude plugin supplies workflow instructions. Neither owns a second framework model.

### First MCP release: inspect and explain a local application

Use an operator-selected workspace and application entry point, defaulting to `ship.config.ts` with its named `app` export. A running HTTP server and a registry endpoint are unnecessary.

Proposed tool names below are a target interface, not available tools today:

| Tool | Behavior and boundary |
| --- | --- |
| `check_app` | Return actual compiler errors and warnings. No repair or collision inference based on text matching. |
| `list_operations` | Return bounded, filterable summaries by ID/module and declared transport/access/transaction attributes. Include non-HTTP operations. |
| `inspect_node` | Inspect an app, module, operation, provider, job, or channel. Show only fields present in the graph; add projected schemas when available and identify exclusions. |
| `affected` | Reuse the existing CLI's declared impact semantics. Report the relationship types it follows; do not claim complete source-file, test, or runtime impact analysis. |
| `get_contract` | Return a bounded, optionally operation-filtered contract projection and its fingerprint. Do not write generated files as a side effect. Distinguish filtered output from a complete contract. |

All results identify the application, projection schema version, generation time, and selected entry point. Return stable structured errors for missing configuration, compilation failure, unknown IDs, unsupported projections, and output limits. Paginate lists and explicitly report truncation. Do not serialize provider instances, actor credentials, environment values, or runtime request data.

Loading `ship.config.ts` executes application code. Inspection is not a sandbox and “read-only tools” is not a guarantee against import-time side effects. Document the trusted-workspace requirement. The configured entry point must be declaration-safe: no server startup, worker startup, or database connection on import. Tool arguments cannot select arbitrary files, shell commands, or remote origins.

Load in a fresh bounded worker process for each request so module caching does not hide declaration edits. Apply a timeout, cancellation, and output limits; keep worker output separate from MCP protocol stdout. Test edits to transitive imports as well as the entry point. Do not claim a contract fingerprint proves freshness of every source file.

### Claude plugin: a small set of evidence-driven workflows

Replace old agents, commands, and rules with current-architecture guidance. Proposed workflows:

1. **Understand:** check the app, inspect the relevant operation/provider, and read its source and tests.
2. **Implement a feature:** design operations, schemas, errors, access, tenant authority, repository/UoW boundaries, and declared effects; modify source and tests using existing primitives. Do not call an operation generator that does not exist. The CLI currently scaffolds a whole application, not arbitrary kernel feature modules.
3. **Review:** combine the actual diff with compiler findings and declared impact. Review authorization, tenant predicates, rollback, idempotency, and contract boundaries in source. Clearly separate deterministic findings from reviewer judgments.
4. **Prepare verification and handoff:** run relevant project checks and generate a QA brief from observed changes and test evidence. Label untested scenarios. No assumed external QA system, deployment, or automatic handoff.

Start with one architecture skill, focused review guidance, and commands that invoke these workflows. Dedicated architect/codegen/reviewer personas are optional implementation choices, not evidence that autonomous orchestration exists. Prefer one shared source of architecture guidance over separate Cursor and Claude copies of outdated rules.

Use the supported Claude plugin layout and validate the actual packaged manifest, commands/skills, hooks if any, and MCP configuration. Keep manifest version and Apache-2.0 metadata consistent with package metadata. Verify installation in a disposable consumer project using the supported plugin mechanism; an npm installation alone is not proof of Claude activation.

Do not ship automatic hooks in the initial replacement. A reminder is not enforcement, and a review suggestion is not an executed review. Deterministic checks belong in the CLI and CI. Add a hook later only with a demonstrated need and a tested, accurately documented effect.

### Keep, replace, and defer

| Old idea | Disposition |
| --- | --- |
| Discover and describe the application | Keep; use operation IDs, the graph, and projected contracts |
| Check route collisions | Replace with compiler diagnostics over the compiled app |
| Scaffold and customize a feature | Keep as a guided source-editing workflow; no fictional generator |
| Review conventions and generate a QA brief | Keep with source, diff, test evidence, and explicit limitations |
| Call a real application to validate behavior | Valuable, but defer from the first release; requires a separate execution design and acceptance gate |
| Trace requests | Defer until there is an explicit configured log/trace source and tested correlation; remove hard-coded log-path and field assumptions |
| Add jobs and schedules | Cover implemented kernel declarations and optional adapter setup in the feature workflow; remove compatibility generator commands |
| Generate database migrations | Use the consumer's actual configured Drizzle command when relevant; remove universal path assumptions and blanket edit-blocking hooks |
| Dual compatibility/kernel detection | Remove from the replacement; incompatible apps receive a clear unsupported-architecture diagnostic |

Live execution must eventually use the real executor/HTTP path with actual actor resolution and tenant authorization. A read transaction does not imply side-effect-free behavior. This repository already has a fixture whose read operation publishes a realtime event. Do not introduce a “safe dry run” or rollback guarantee without proving what happens to external effects, outbox work, jobs, cache invalidation, and realtime publication.

### Package and release transition

Proposed replacement names are `@sixthsummit/ship-mcp-server` and `@sixthsummit/ship-claude-plugin`. Check registry availability before adopting them. Use independent versions; the framework's package versions are not a compatibility test.

The replacement does not contain a legacy mode. Once a replacement release passes its gates, retire the old agent packages and add npm deprecation notices pointing to explicit replacement/setup instructions. Keep historical published artifacts; do not delete them or rewrite their changelogs. No additional feature development goes into the old tooling. This does not itself revoke the separate compatibility framework's support window in ADR-0012.

New package names require release-plan, CI, archive verification, documentation, and trusted-publisher onboarding updates. Complete those as part of implementation; do not describe the new packages as installable until verified published archives exist.

## Delivery gates

1. **Shared inspection core:** prove CLI/MCP result and error parity using the same valid and invalid application fixtures. Cover jobs, channels, outboxes, access, cache invalidation, non-HTTP operations, and contract exclusions. Extract missing shared seams without changing their semantics silently.
2. **MCP:** prove all five tools through a real stdio client, bounded output/errors, cancellation/timeouts, and freshness after a transitive source edit. Prove inspection does not instantiate providers or start runtimes for declaration-safe fixtures. Test rejection of a compatibility-only configuration and unknown IDs.
3. **Plugin:** validate the real packed layout and metadata, install in a disposable current-architecture consumer, and exercise each workflow. Remove references to unavailable commands and unsupported automatic behavior. Record the exact checks and what human/agent behavior was observed.
4. **Release and retirement:** run clean packed-consumer and appropriate monorepo CI gates, publish an alpha via the protected release workflow, verify archive integrity/provenance, then update installation docs and deprecate the old tooling packages. New npm authentication is onboarding work, not an ongoing release dependency.

Do not implement deferred live execution or tracing just to preserve a feature count. Each needs its own concrete user need, implementation, and evidence before it appears as supported functionality.

## Consequences

Agents get useful access to architecture the framework actually implements without requiring a compatibility server. The first replacement is smaller than the old advertised surface, but its behavior can be verified independently of prompt wording. Existing tooling consumers must change configuration; maintaining two architecture modes is intentionally excluded.

## Alternatives considered

- **Patch old prompts and retain the route server:** leaves the wrong application model and cannot expose non-HTTP operations or dependency structure.
- **Build a large autonomous agent suite first:** duplicates orchestration before proving the underlying tools and repeats the gap between aspiration and execution.
- **Expose only a static OpenAPI document:** useful for HTTP consumers, but insufficient for provider lifetimes, declared effects, non-HTTP operations, and internal application structure.
