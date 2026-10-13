# RFC: Re-envision ShipAPI as an agent-native application kernel

- **Status:** Proposal
- **Date:** 2026-09-03
- **Branch:** `rearchitecture/agent-native-framework`
- **Baseline:** `dev` at `9022c8fc922f773dd723921edd5973ec81bf283b`

## Executive decision

Do not spend the next release cycle polishing the current v4 architecture into a general-purpose framework. Preserve its proven low-level pieces, but replace its composition model with a small application kernel built around explicit operations, modules, dependencies, and execution boundaries.

The current repository has useful ingredients—Hono, Zod, Drizzle, structured errors, request-context plumbing, logging, tracing, real-PostgreSQL tests, and a promising route-execution idea—but it does not yet have one coherent model of an application. Runtime routes, route metadata, generated clients, copied modules, scaffolds, documentation, agent rules, and MCP tools are parallel descriptions that can disagree.

The highest-value change is to create one executable application graph and derive those views from it. “Agent-native” should mean that ordinary engineering constraints are explicit, local, typed, fast to check, and machine-readable. It should not mean that agents are expected to recover missing architecture from prompts.

A useful forcing function is:

> If every `AGENTS.md`, skill, prompt, and MCP server disappeared, would a capable engineer or coding agent still discover the correct extension point from the types, code layout, diagnostics, and tests?

For the new architecture, the answer must be yes. Agent-specific interfaces can accelerate the feedback loop, but they must not carry correctness.

## Why an application kernel

The framework needs one executable source for operation identity, schemas,
authorization, transactions, effects, transport, and generated clients. Separate
route, service, and registry abstractions can otherwise disagree. The accepted
architecture decisions record how the replacement makes these invariants explicit.

## What “agent-native” means

An agent-native repository is a well-architected repository with unusually good feedback surfaces. It has the following properties.

### One source of application truth

An endpoint is not separately described in a route, registry wrapper, OpenAPI fragment, client type, permission table, module manifest, prompt, and test inventory. It is one operation declaration from which the mechanical views are derived.

### Local reasoning

A change to one operation can be understood by reading that operation, its domain service, and its tests. Hidden global registries, import-time mutation, decorators, monkey-patching, and ambient transaction behavior are excluded.

### Correctness by construction

Authorization, validation, transaction scope, tenancy, idempotency, and external effects are declared or passed through typed boundaries. They are not conventions that can be silently omitted.

### Deterministic, structured feedback

Biome, TypeScript, the application compiler, and focused tests return stable error codes, source locations, and suggested fixes. The same checks run locally and in CI. JSON output exists for tools; readable output exists for humans.

### Bounded context discovery

The application graph answers questions such as “what calls this service?”, “which operations write this table?”, “which routes require this permission?”, and “which jobs emit external effects?” without loading the entire repository into context.

### Prompts are adapters, not architecture

CLI, MCP, editor integration, and agent skills may expose the graph and commands. None owns a separate model or a behavior that cannot be reached and tested through the normal package APIs and CLI.

## Current architecture diagnosis

### There is no application kernel

The scaffold, lifecycle manager, module helpers, route registry, service layer, and developer tools do not compose into one application object with a validated lifecycle. The framework can construct useful parts, but consumers must decide how those parts actually fit together.

The result is documentation-heavy integration and repeated consumer-specific wiring. A framework should make its safe path the shortest path.

### The route registry is a shadow runtime

Route metadata is captured by intercepting a subset of Hono registration methods. That creates a second, incomplete model of routing with global state and parity obligations. Runtime routing remains authoritative, while developer tooling behaves as if the registry were authoritative.

This is why path prefixing, collision detection, and direct route execution all need bespoke tests. Parameterized routes also expose the mismatch: a declared path such as `/accounts/:id` is not itself an executable request path such as `/accounts/123`.

### Correctness rules are conventions

The transaction helper records an active transaction, but service instances can continue using their original database connection. Tenant-scoped schemas identify a column without ensuring every query is scoped. Lifecycle hooks make behavior less visible and can perform writes outside the operation’s intended boundary. Broad generic services return shapes too weak for TypeScript to protect consumers.

These are framework-level failure modes because they allow code to look compliant while doing the wrong thing.

### Ownership and upgrades are unclear

Some modules are copied into consumers, some behavior is packaged, and some templates refer to reference implementations that are not executable. Copied source immediately forks ownership; package upgrades cannot safely update it. A module manifest that can be skipped or drift from the filesystem is metadata, not architecture.

### The agent layer is mostly a prose overlay

Rules, generated skills, prompts, code-review guidance, and MCP commands contain useful intent, but much of it is advisory. Stale prompt code, acknowledged rule hashes, suggestion-only review hooks, and periodic manual evaluations do not prevent an invalid application from compiling or shipping.

### The monorepo has no trust-zone model

Runtime dependencies, test tooling, MCP development tooling, and the static docs site are audited as one dependency tree. That makes unrelated advisories share one release gate and has led to an expanding path-specific allowlist. CI status no longer communicates whether the published runtime is healthy.

## Target architecture

### 1. The operation is the primary unit

An operation describes one callable capability. HTTP is one adapter onto it, not the place where business execution is defined.

Illustrative API:

```ts
export const getAccount = defineOperation({
  id: "accounts.get",
  transport: http.get("/v1/accounts/:accountId"),
  input: {
    params: z.object({ accountId: accountIdSchema }),
  },
  output: {
    200: accountViewSchema,
  },
  successStatus: 200,
  errors: [accountNotFound],
  access: permission("accounts:read"),
  transaction: "read",
  handler: async ({ input, services }) => {
    return services.accounts.get(input.params.accountId);
  },
});
```

This declaration is executable TypeScript, not passive configuration. Its types constrain the handler and the HTTP adapter. The application compiler validates properties TypeScript cannot validate across the whole graph.

The initial operation contract should include only load-bearing fields:

- stable operation ID;
- input schemas by transport location;
- output schemas by status or result variant;
- declared error codes;
- access policy;
- transaction mode;
- handler and explicit dependencies;
- optional effect and idempotency declarations when the operation performs them.

Do not begin with an all-purpose policy language. Add a field only when it enables a concrete invariant, derived artifact, or diagnostic.

### 2. Modules are explicit graph nodes

```ts
export const accountsModule = defineModule({
  id: "accounts",
  operations: [getAccount, updateAccount],
  providers: [accountsRepository],
  events: [accountUpdated],
  jobs: [],
});
```

Modules declare what they provide and consume. They do not mutate a global registry at import time. The compiler rejects duplicate operation IDs, route collisions, dependency cycles, undeclared cross-module imports, and missing providers.

### 3. The application is a compiled graph

```ts
export const app = defineApp({
  id: "example-api",
  modules: [accountsModule, billingModule],
});

export const httpApp = createHonoAdapter(app);
```

Compilation produces or exposes:

- the runtime Hono application;
- route and operation inventory;
- OpenAPI and transport-independent schemas;
- generated client types that do not depend on `typeof` a deeply chained Hono router;
- `.ship/graph.json` for impact analysis and tools;
- diagnostics for missing policies, collisions, dependency violations, and unbound effects;
- stable operation IDs for focused tests and migration accounting.

The compiler is a validator and projector over ordinary TypeScript declarations. It must not rewrite source files, depend on fragile AST formatting, or hide runtime behavior behind decorators.

### 4. Execution is transport-independent

The kernel executes an operation with explicit input and execution context. The Hono adapter translates HTTP requests and results. Tests and tools call the same kernel path.

```ts
await testApp.run("accounts.get", {
  input: { params: { accountId } },
  actor,
  request: { id: "test-request" },
});
```

`run_operation` should therefore be real execution, not synthetic HTTP path lookup against shadow metadata. `run_scenario` can compose operations while preserving per-step identity, transaction, clock, and effect fakes.

HTTP integration tests still use `app.request()` to prove adapter behavior. The kernel path complements rather than replaces them.

### 5. Transactions use scoped dependencies

Replace ambient “transaction present in context” behavior with a unit-of-work boundary that constructs transaction-scoped repositories and services.

```ts
const transfer = defineOperation({
  id: "accounts.transfer",
  transaction: "write",
  dependencies: { tx: primaryDatabase },
  // ...schemas, errors, and access...
  handler: async ({ services }) => {
    await services.tx.accounts.debit(...);
    await services.tx.ledger.append(...);
  },
});
```

The operation executor—not the handler—opens the declared unit of work. The base database connection is not reachable from `tx` services. Transactional handlers receive only transaction-scoped capabilities. Nested operations join the current unit of work by default or are rejected by explicit adapter policy; read-only work cannot escalate to a nested write.

Database transactions do not make external effects atomic. An operation that sends, publishes, uploads, or calls a provider declares that effect and uses an explicitly chosen delivery strategy. An outbox can be one strategy after it is proven; it should not be silently bundled into the kernel.

### 6. Prefer domain repositories over a universal CRUD service

Keep small typed helpers for filters, pagination, timestamps, and soft-delete predicates where they reduce repetition. Do not make a generic entity service the main domain abstraction.

Each repository exposes the queries and writes its domain actually supports, with inferred input and result types. Relation loading is expressed as named domain projections rather than an unbounded string array. This makes query cost, selected fields, tenancy, and transaction use reviewable.

The reusable layer is deliberately mechanical: bounded offset windows, immutable page results, semantic-to-physical audit/soft-delete column mappings, and closed registries of typed projection query functions. It does not own arbitrary filters, domain defaults, joins, or CRUD workflows. See [ADR-0007](./rearchitecture/decisions/0007-domain-repositories-and-named-projections.md).

### 7. Tenancy and authorization are capabilities

If an application enables tenancy, tenant-scoped repositories require a tenant capability and cannot be constructed without it. Bypass is a distinct privileged capability with an auditable call site.

Tenant capabilities are issued by an application-owned asynchronous authorization policy from a validated operation actor, tenant identifier, and invocation identifier; there is no public raw-scope constructor. A transaction-scoped repository factory then exposes `forTenant(scope)` and, only when explicitly declared, a separately typed `withBypass(bypass)` surface. Bypass issuance and repository use must synchronously reach an audit sink or access fails closed. Domain repositories retain explicit tenant predicates and prove them with cross-tenant read/write attempts against PostgreSQL. See [ADR-0008](./rearchitecture/decisions/0008-authorized-tenant-capabilities.md).

Authorization policies are named, composable functions with declared inputs and test fixtures. HTTP middleware may reject early, but the operation boundary remains authoritative so non-HTTP execution cannot bypass access checks.

Credential extraction is transport-owned. A transport-independent actor resolver receives typed credential evidence and the target operation's declared access, then produces a minimal actor and immutable permission snapshot for that invocation. `publicAccess()` is the optional-auth mode: missing credentials may remain anonymous, while present invalid credentials are rejected. Current v4 `AuthProvider` implementations use an explicit compatibility bridge rather than becoming kernel dependencies. See [ADR-0004](./rearchitecture/decisions/0004-credential-actor-and-access-boundary.md).

### 8. Package boundaries match trust and ownership

A clean package split should look approximately like:

- `@sixthsummit/ship-core`: operation, module, application graph, execution, errors;
- `@sixthsummit/ship-hono`: HTTP adapter and Hono-specific context;
- `@sixthsummit/ship-drizzle`: PostgreSQL/Drizzle repositories and unit of work;
- `@sixthsummit/ship-auth-firebase`: Firebase credential adapter;
- `@sixthsummit/ship-observability-otel`: optional OpenTelemetry integration;
- `@sixthsummit/ship-testing`: application fixture and scenario runner;
- `@sixthsummit/ship-cli`: compile, inspect, check, and migration commands.

Exact names are not important yet. The boundaries are. Core must not boot OpenTelemetry, Firebase, Redis, queues, or PostgreSQL merely because a consumer imported the framework. Adapters must be independently versioned and audited.

Reference modules are executable examples and conformance fixtures, not source-copied infrastructure. Consumer-owned business modules live in the consumer repository. Framework-owned capabilities remain packages with explicit versions and migrations.

## Repository feedback loop

The default local loop should be conventional and fast:

```text
biome check
tsc --noEmit
ship check --changed
ship test --changed
```

- Biome owns formatting, imports, and high-signal syntax-level rules.
- TypeScript owns the static program contract.
- `ship check` owns application-graph and architectural invariants.
- Vitest and real infrastructure tests own behavior.

Keep a custom lint rule only when it is high-signal and cannot be expressed more directly in the compiler or type system. Avoid maintaining a large style stack merely to look comprehensive.

Every framework diagnostic should have:

- a stable code such as `SHIP_ROUTE_COLLISION`;
- the operation/module and source location;
- the violated invariant;
- the smallest useful remediation;
- human-readable and JSON forms.

Useful commands are projections over the same graph:

```text
ship inspect operation accounts.get
ship inspect module accounts
ship affected packages/core/src/accounts/repository.ts
ship run accounts.get --fixture authenticated-admin
ship scenario credits.transfer.concurrent
ship check --format json
```

An MCP server, if retained, is a thin transport over these commands and APIs. It must not own another route registry, prompt set, or execution model.

## What to retain, replace, and remove

### Retain and harden

- Hono as the first HTTP adapter;
- Zod schemas at external boundaries;
- Drizzle as the first database adapter;
- `app.request()` HTTP tests;
- the structured error vocabulary and safe serialization intent;
- request IDs, logging, tracing, and redaction primitives;
- real-PostgreSQL integration tests;
- Changesets and packed-consumer release proof;
- the idea behind route/operation execution and scenarios;
- explicit job leases, idempotency, and outbox semantics where proven.

### Replace

- route interception with operation-derived routing and metadata;
- `hc<typeof app>` as the public client contract with operation-derived clients;
- broad generic entity services with typed domain repositories and helpers;
- ambient transaction propagation with scoped unit-of-work dependencies;
- filesystem/module conventions with compiled module boundaries;
- scaffold success with a generated-app conformance test;
- prose-driven agent workflows with graph-backed commands and diagnostics;
- one monorepo audit gate with package/trust-zone gates.

### Remove or demote

- global registries and import-time mutation;
- source-copied framework infrastructure;
- mandatory multi-file CRUD ceremonies;
- lifecycle hooks that can hide writes or effects;
- unimplemented lifecycle abstractions;
- duplicated canonical rules across prompts, skills, and docs;
- prompt-based code generation as a correctness mechanism;
- suggestion-only review theater;
- decorative CI jobs that cannot affect a decision.

## CI and dependency trust model

### What the current failure wall actually says

The CI forensics snapshot from 2026-09-01 found that 65 of the last 100 scheduled Security runs failed, all at the same `audit-ci` gate. On the current `dev` head, lint, type-check, build, unit tests, integration tests, edge smoke, docs build, and skills sync were green. The latest CI run was red because the same audit job failed and the summary propagated it.

The repository confirms the structural causes:

- `.audit-ci.json` scans dev dependencies and the entire workspace tree with one high/critical threshold;
- path-specific exceptions mix Astro, Vite, Undici, `form-data`, and other trust zones;
- the weekly `npm audit fix` step exits before it can open a PR when unfixable advisories remain;
- the dependency workflow always attempts to use repository Issues even though Issues are disabled;
- the license job prints top-level packages and ends successfully even when the command fails;
- scheduled failures have no reliable delivery path to a human.

This is not evidence that security should be non-blocking. It is evidence that the gate does not model what ships.

### Immediate hygiene before architecture work

Treat the existing forensic remediation as a bounded first PR series:

1. Apply and review the non-major lockfile audit fixes; rerun all existing tests.
2. Upgrade the runtime OpenTelemetry chain and verify boot, trace export, and log correlation.
3. Select a patched compatible Hono release rather than retaining a known-vulnerable override.
4. Upgrade the docs toolchain independently; it must not gate a core runtime release.
5. Repair dependency automation so it can open a lockfile PR even when a later audit still reports residual findings.
6. Remove the disabled-Issues path or replace it with the PR/artifact channel the repository actually uses.
7. Implement a real license allow/deny policy or delete the job.
8. Deliver scheduled failures to an owned channel with an acknowledgement expectation.

These repairs restore trust in the current branch while the new kernel is developed. They should not be bundled with the architectural implementation.

### Target gates by trust zone

| Zone | Examples | Required decision |
|---|---|---|
| Published runtime | core, Hono adapter, selected runtime adapters | Hard-fail the release on the production dependency tree of each packed artifact. Record artifact/SBOM and accepted exceptions with owner and expiry. |
| Optional adapters | Firebase, OTel, Redis, PostgreSQL | Gate the adapter that contains the dependency. Do not make an unused adapter part of core exposure. |
| Build and test tooling | Vitest, testcontainers, release tooling, CLI development dependencies | Scan and maintain separately. Block when the tool executes untrusted input or the approved policy requires it; do not describe it as consumer runtime exposure. |
| Documentation site | Astro/Starlight and site plugins | Gate documentation deployment and its own maintenance SLA, not framework publication. |

The authoritative runtime audit should install each packed publishable artifact into a clean temporary consumer and inspect only its production tree. Root-workspace audit remains useful as a maintenance report, not as a substitute for artifact exposure.

CI summaries must distinguish code failure, runtime dependency failure, toolchain maintenance, and documentation maintenance. One red box should identify one actionable owner and trust zone.

## Framework acceptance

Use the minimal and customized synthetic consumers, packed contract fixtures,
transport conformance, and repository verification gates to validate the kernel.
Application-specific migrations and deployment evidence belong in application
repositories. See [architecture decisions](rearchitecture/decisions/README.md)
and [implementation status](V4_STATUS.md) for the framework record.
