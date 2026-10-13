# Agent eval harness

These tasks make the “safe and fast for agents” claim falsifiable. Each task has an input
brief, an isolated target workspace, and a deterministic grader. Repository CI validates
the task definitions; it does not pretend the untouched repository is an agent result.

## Two distinct gates

`pnpm evals:validate` is deterministic and runs in repository CI. It verifies that every
task has valid metadata and shell, invokes the pnpm quality gate, and teaches the current
operation-client or independent third-party REST architecture.

An end-to-end eval requires a real execution:

1. create a fresh ShipAngular application or framework worktree;
2. install the packed framework and, for operation tasks, the packed conformance contract;
3. give one brief to a fresh agent with no task-specific transcript;
4. let the agent finish or time out;
5. grade that exact workspace with an explicit path; and
6. record the agent/model/tool versions and run ID with the result.

Until a CI-owned agent driver can perform steps 1–4, end-to-end scores are manual evidence,
not a release gate. A grader run against a baseline where no agent attempted the brief is
not a meaningful score.

## Targets

Each `meta.json` declares:

- `target: "app"` for a generated consumer application;
- `target: "framework"` for a framework worktree; and
- `architecture: "operation-client" | "third-party-rest"` for the boundary under test.

Most tasks are application-targeted because feature modules are app-owned. ShipAngular no
longer copies a framework-owned module catalog into consumers.

## Commands

```bash
# Deterministic definition gate used by CI
pnpm evals:validate

# Grade one completed agent workspace
pnpm evals:run -- eval-005-streaming-chat --workspace /tmp/ship-eval-chat

# Grade all app tasks attempted in the same prepared workspace
pnpm evals:run -- --all --app --workspace /tmp/ship-eval-app

# Record an attributable result
pnpm evals:run -- eval-005-streaming-chat \
  --workspace /tmp/ship-eval-chat \
  --record \
  --run-id codex-2026-09-04-001
```

`--record` deliberately requires `--run-id`. Result filenames are
`evals/results/<framework-version>-<run-id>.json` so separate runs cannot silently replace
one another.

## Task anatomy

```text
evals/agent-tasks/<id>/
├── brief.md
├── setup.sh        # optional, for a runner that prepares fixtures
├── grade.sh
├── meta.json
└── fixtures/       # optional packed/local fixtures
```

Graders inspect outcomes and architectural invariants, then run `pnpm run ci`. They should not
require arbitrary formatting or a private implementation name when a behavior can be
proven through TypeScript or tests. New test files use `FileName.test.ts`.

## Current battery

| ID       | Boundary exercised                                         |
| -------- | ---------------------------------------------------------- |
| eval-001 | App-owned guarded feature + typed operation mutation       |
| eval-002 | Capability-based custom `AuthAdapter` conformance          |
| eval-003 | App-owned guarded page + signal auth state                 |
| eval-004 | Independent third-party REST mocking with MSW              |
| eval-005 | Typed operation SSE, cancellation, failures                |
| eval-006 | Typed operation WebSocket, ticket/protocol safety          |
| eval-007 | Typed operation upload, progress, constraints              |
| eval-008 | Operation-backed cookie session + shared credential policy |
| eval-009 | Safe request policy, idempotency, retry, cancellation      |

## Result interpretation

A result is comparable only when the framework version, task revision, contract fixture,
agent/model, tools, time limit, and starting workspace are held constant. Store those in
the external run record or run artifact. Pass rate is useful only after those controls are
present; it must never be inferred from running task graders directly on this repository.
