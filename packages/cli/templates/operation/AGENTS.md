# Agent guide

This repository is a ShipAPI operation application. The compiled operation graph,
not a prompt, folder name, Hono handler, or generated document, defines behavior.

## Start here

1. Run `pnpm ship-api inspect app --format json`.
2. Inspect the affected module or operation by stable ID.
3. Read only that module, its declared providers, and colocated tests.
4. Run `pnpm ship-api affected <kind> <id> --format json` before changing a shared node.

## Structure

- `src/application.ts` is the composition root.
- `src/modules/<module>/module.ts` owns a bounded feature.
- `*.operation.ts` declares input, output, errors, access, transaction mode,
  dependencies, effects, transport, and handler together.
- `ship.config.ts` exposes the compiled app to deterministic CLI tooling.
- `.ship/contract.json` and `.ship/openapi.json` are generated projections.

## Invariants

- Keep domain behavior transport-independent; Hono is an adapter.
- Never read a database, auth provider, clock, queue, or external service from
  ambient global state. Declare the capability as an operation dependency.
- A write declares `transaction: "write"`; do not hide writes in read operations.
- Declare external effects and their delivery semantics. Do not perform them from
  an unlisted dependency.
- Expected failures are declared operation errors; do not throw message-shaped
  protocol responses from handlers.
- Treat operation IDs and error codes as public compatibility keys.
- Do not hand-edit generated contract or OpenAPI artifacts.

## Tests and gates

Tests use Vitest, are colocated as `FileName.test.ts`, and verify one behavior per
test. Generate tests with code, then review their assertions and failure paths.

Run `pnpm run verify` before handing off a change. It checks Biome, the graph,
TypeScript, unit tests, 80% coverage, HTTP integration, the production build, and
contract generation. Do not skip a failing gate because older tests look stale;
change a test only when the declared behavior intentionally changed.

Commits use `<type>(<scope>): <imperative description>`. Keep logical changes
separate. Use `fix` only for user-facing defects.
