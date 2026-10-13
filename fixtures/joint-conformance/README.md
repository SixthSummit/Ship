# Real packed joint fixture

Run after the API packages are built, with the pinned Node and pnpm versions:

```sh
node scripts/build-joint-conformance.mjs --out /tmp/ship-joint
```

This loads an actual compiled operation graph through `generateContractArtifacts`, emits its
structural manifest/types, and bundles the built HTTP client separately from the Hono fixture server.
The browser projection retains the real `ClientTypeContract`. The fixture client uses the
canonical `@sixthsummit/ship-contract/client` declaration, so adapters compare one generic
client type rather than separate copies. The server is installed only in the Node test runner.

Run the producer twice into different directories and compare `manifest.json`. Tarball hashes,
graph fingerprint, versions and bundled source hash must be identical. `producer.head` identifies
the base commit; `producer.sourceHash` identifies the actual bundled graph/server including local
changes. No claim is made that an uncommitted candidate is represented by its base commit alone.

Copy all six tarballs and the manifest into ShipAngular's `conformance/joint/artifacts/`, review
the manifest diff, then run `pnpm test:joint-conformance` there. CI uses that exact retained bundle;
it cannot silently load a sibling checkout or substitute the synthetic fixture. Ordinary Angular
peers come from its frozen registry installation, while every Ship package under test comes from
an archive. Updating API behavior requires a reviewed refreshed bundle before migrating consumers.

The supported gate covers unary JSON 200/201, 204, declared 404 with typed details, standard validation,
request IDs, cancellation, generated primitive forms, browser execution and concurrent request
injectors. This fixture is development-only and uses public access and permissive localhost CORS.
It is not a production auth or CORS template.

Backend SSE/WebSocket, generated non-JSON bindings, advanced codecs, production credential-provider integration,
idempotency/retry server behavior and the full proposed C1 roadmap matrix remain separate acceptance
work. Existing Angular transport tests remain required; those tests do not imply these backend
capabilities are generated or available.

The aggregate `artifactSetHash` covers the graph plus every archive name, version and checksum. Compare it and the full archive set when refreshing client/form behavior; `producer.sourceHash` covers only the server bundle. The expanded fixture also proves deliberately overlapping SSR HTML rendering and modeled cookie-session refresh/replay with browser cookie captures. Its in-memory session model is test-only.
