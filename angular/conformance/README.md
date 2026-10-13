# Packed conformance fixtures

This directory tests the package boundary between ShipAngular and ShipAPI. It deliberately is not
a pnpm workspace: the verifier packs each artifact and installs the tarballs into a temporary clean
consumer so a workspace link cannot make a broken package appear valid.

## Local required gate

```bash
pnpm build
pnpm test:packed-conformance
pnpm test:browser-conformance
```

The local gate packs:

- the built `@sixthsummit/ship-angular` package;
- the synthetic client-safe contract under `shipapi-fixture/contract`; and
- the synthetic structural client under `shipapi-fixture/client`.

It validates public export targets, scans compiled JavaScript and declarations for forbidden
server imports, compiles positive and negative consumers with strict TypeScript settings, executes
200/201/204/declared-failure/cancellation cases, and prints package checksums plus the graph hash.
Ordinary Angular/compiler peer packages are linked from the repository's already-installed registry
dependencies; only the three packages under conformance are accepted from their tarballs.

The synthetic packages are protocol fixtures, not an application contract and not publishable
ShipAPI output. They keep ShipAngular's boundary test deterministic while the coordinated ShipAPI
artifact is under development.

The browser gate extracts a fresh ShipAngular tarball into another temporary consumer, compiles
only its public imports, and serves it separately from a deterministic HTTP/WebSocket fixture. Real
Chromium exercises cross-origin cookie/CORS policy, XHR upload progress and abort, binary download
metadata and abort, split SSE frames and reader abort, and socket protocol/reconnect behavior. Run
`pnpm exec playwright install chromium` once before using it locally.

## Joint ShipAPI gate

```bash
SHIP_API_CONFORMANCE_MANIFEST=/absolute/path/to/manifest.json \
  pnpm test:joint-conformance
```

`test:joint-conformance` rejects the synthetic fallback. The external manifest must contain
`fixtureProtocolVersion`, `wireFixtureVersion`, `graphHash`, and `contractPackage` / `clientPackage`
objects with `name`, `version`, `tarball`, and `sha256`. Tarball paths are resolved relative to the
manifest. Optional `import` fields can identify package import specifiers when they differ from
package names.

The external packages must expose the fixture names consumed by the checked programs:

- contract: `FixtureContract` and `contractMetadata`;
- client: `createFixtureClient()` with a typed `call(operationId, input, options)` method.

This is the handoff surface for ShipAPI's generated fixture. No sibling checkout, source import,
live provider, or production system is accepted.
