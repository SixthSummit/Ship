# {{PROJECT_NAME}}

An operation-native ShipAPI service. One compiled application graph drives direct
execution, HTTP, client contracts, OpenAPI, and inspection tooling.

## Run

```sh
pnpm install
pnpm run verify
pnpm run dev
```

`GET http://localhost:3000/health` executes `system.health` through the Hono
adapter. The same operation runs without HTTP in `src/application.test.ts`.

## Extend

Add a bounded directory under `src/modules/`. Declare operations with stable IDs,
schemas, errors, access, transaction mode, dependencies, effects, and transport;
then add the module to `src/application.ts`.

Use the graph before reading the entire repository:

```sh
pnpm ship-api inspect app
pnpm ship-api inspect operation system.health
pnpm ship-api affected module system
pnpm run contract
```

Read `AGENTS.md` for the invariants and test workflow. To use the repository commit
template locally, run:

```sh
git config commit.template .gitmessage
```
