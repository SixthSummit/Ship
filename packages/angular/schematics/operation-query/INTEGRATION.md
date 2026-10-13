# Operation query generator integration

Register the generator in `schematics/collection.json` during M6.

```json
"operation-query": {
  "description": "Generate a typed safe query with explicit application bindings.",
  "factory": "./operation-query/index#operationQuery",
  "schema": "./operation-query/schema.json"
}
```

Export `defineShipReadBinding`, `injectShipQuery`, `ShipQueryContext`, `ShipQueryEnvelope`, and `ShipQueryOptions` from `/query`.
Keep `InputOf` and `OperationClient` in `/operations`.
Keep TanStack optional for consumers of the root and `/operations`.

Add `schematics/operation-query/*.test.ts` to the central runtime test program.
Exclude `schematics/**/*.test.ts` and fixture declarations from the schematic production build.
The current schematic build excludes only `.spec.ts` tests.
Preserve the existing schematic templates and default starter.

The scope source is an injection token for `ShipQueryContext`.
The application must provide that token through its query provider configuration.
The application supplies its namespace, identity scope, typed client token, input key mapper, and response variant key.
The generator supplies none of those values.

Call the generated factory's `create` method in a component injection context.
Read reactive input inside its input callback.
Use the returned envelope's `data` field for the response body.
Use its `result` field for the complete response metadata.
Options support typed selection and reactive option callbacks.
They cannot replace execution, keys, or retry policy.

`setupQuery` defaults to false.
When true, it adds the exact runtime dependency `@tanstack/angular-query-experimental: 5.104.1` to application `package.json`.
It rejects conflicting dependency versions before rendering.
It preserves unrelated manifest fields and dependencies.
It schedules no network installation task.
Run the application's package manager after generation.

Author verification used Angular 20.3.30, TypeScript 5.8.3, and TanStack 5.104.1 declarations.
Fifty local tests cover runtime generation, consumer fixture compilation, rejected inputs, and existing resource output preservation.
The declaration fixture validates the documented API contract.
M6 must also compile a generated consumer against the physical packed package.

# M6 package composition notes

Add `query/ng-package.json` and the public query entrypoint.
Compose the real keys, read executor, finite and infinite queries, providers, scope, mutations, and cache effects.
Do not export internal registration markers or observer scope wrappers.
Register the query package export and exact optional peer dependency in the published package manifest.
Add the exact development dependency for repository checks.
Update the lockfile through the repository package manager.

Register query paths in central runtime tests, coverage, strict type tests, lint, Knip, and bundle measurement.
Remove track-only finite and infinite harness configurations from the published source.
Add documentation navigation and the scope-aware query generator guide.
Keep identity-sensitive application examples on `injectShipQuery` and `injectShipInfiniteQuery`.
Low-level native options require an explicit scope guard.

Run packed consumer checks after the real modules replace every track fixture.
Prove that root and operation-only consumers can omit TanStack.
Run the existing resource and mutation tests to prove compatibility.
