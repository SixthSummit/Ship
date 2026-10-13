# Quick start

Create the smallest operation-native ShipAPI service and verify the complete
contract before adding business behavior.

> **Registry:** packages use GitHub Packages. Configure
> `@sixthsummit:registry=https://npm.pkg.github.com` and any required read token
> in user-level npm configuration. Replace `<exact-version>` below with a released
> CLI version from its package changelog; never commit credentials.

## 1. Create the application

```sh
pnpm dlx "@sixthsummit/ship-cli@<exact-version>" create my-api
cd my-api
```

The command installs pnpm dependencies by default. Use `--skip-install` in
automation or `create . --current-dir` in an empty directory.

The generated repository contains one public health operation, a Hono server,
direct and HTTP tests, strict TypeScript, Biome, an 80% coverage floor, graph and
contract tooling, `AGENTS.md`, `.gitmessage`, and a pull-request template. Every
focused Ship package is pinned to the exact version recorded by the CLI release
build.

## 2. Prove the baseline

```sh
pnpm run verify
```

The generated gate runs:

- Biome;
- application-graph compilation;
- TypeScript;
- unit tests;
- coverage with 80% thresholds for statements, branches, functions, and lines;
- HTTP integration tests;
- the production build; and
- deterministic client-contract and OpenAPI generation.

Do this before editing. A clean baseline makes every later failure attributable
to the change under review.

## 3. Inspect before reading broadly

```sh
pnpm ship-api inspect app --format json
pnpm ship-api inspect operation system.health --format json
pnpm ship-api affected module system --format json
```

These commands query the compiled graph. They report actual ownership,
dependencies, access, transaction mode, transport, and downstream impact without
requiring an agent to infer architecture from folder names or a prose rule.

## 4. Read the operation

The generated operation is complete and executable:

```ts
export const readHealth = defineOperation({
  id: "system.health",
  transport: http.get("/health"),
  input: {},
  output: { 200: healthOutput },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: async () => ({ ok: true as const, service: "my-api" as const }),
});
```

The stable operation ID is the client identity. The Hono path is one transport
binding. The same declaration drives direct execution, HTTP, graph inspection,
the client manifest, and OpenAPI.

## 5. Run it

```sh
pnpm run dev
curl http://localhost:3000/health
```

The response is:

```json
{ "ok": true, "service": "my-api" }
```

The direct unit test runs `system.health` without opening a socket. The HTTP
integration test projects the same operation onto Hono and checks its wire
response.

## 6. Add a feature

Create a bounded module under `src/modules/<feature>/`:

1. declare operations in colocated `*.operation.ts` files;
2. declare capabilities for databases, auth, clocks, queues, and external APIs
   rather than reading ambient globals;
3. specify every input, status-indexed output, expected error, access policy,
   transaction mode, external effect, and transport;
4. compose the operations with `defineModule()`;
5. add the module to `src/application.ts`; and
6. add reviewed unit and adapter-level tests beside the behavior.

Then run:

```sh
pnpm run verify
pnpm ship-api affected module <feature> --format json
```

Database, Firebase, and OpenTelemetry support are separate adapters. Add only the
ones the operation graph actually needs; the core kernel does not pull them into
every service. Adapters declare `@sixthsummit/ship-core` (and, where they use it,
`@sixthsummit/ship-hono`) as peer dependencies, so they always share the app's
single copy. Keep both as direct dependencies of the app, as the generated
project does, and install adapters at a version that accepts them.

## 7. Consume the contract

`pnpm run contract` writes `.ship/contract.json` and `.ship/openapi.json` from the
same compiled graph. The default browser-safe client calls stable operation IDs
and returns declared API failures as values:

```ts
const result = await client.call("system.health", {});
if (result.ok) console.log(result.data.service);
```

See [Typed operation client](cross-framework/typed-client.md) for result and
metadata semantics. The current route-first `@sixthsummit/ship-api` scaffold and
`hc<typeof app>()` client remain supported compatibility surfaces during the v4
migration window; they are not the starting point for a new operation app.
