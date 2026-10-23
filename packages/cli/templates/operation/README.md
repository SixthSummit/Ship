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

## Browser clients on another origin

`src/http.ts` builds the adapter with a cross-origin policy from the
`CORS_ORIGINS` environment variable, a comma-separated allowlist:

```sh
CORS_ORIGINS=https://app.example.com,https://admin.example.com pnpm run dev
```

Listed origins may send credentials (cookies, `Authorization`), preflights are
answered for every route, and `X-Request-Id` is exposed to the browser. Leave it
unset when no browser calls the API from another origin. `CORS_ORIGINS=*` is
refused at boot: browsers reject a wildcard with credentials, and a server that
emits it anyway is a CSRF bypass waiting for a lenient client. Change the policy
(for example `exposeHeaders` for headers your operations set) in `src/http.ts`;
the `hono` dependency is yours to pin, within the range `@sixthsummit/ship-hono`
declares as a peer, so the app and the adapter always share one Hono copy.

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
