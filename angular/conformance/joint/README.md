# Retained ShipAPI joint gate

`pnpm test:joint-conformance` uses `artifacts/manifest.json` and verifies every archive checksum
before installing the packages. An explicit `--manifest <path>` tests a new producer candidate.
Missing/incompatible artifacts fail the gate. The regular synthetic packed fixture remains useful
for frontend-only protocol cases but is never a fallback for this command.

The manifest records the producing API base commit and bundled source fingerprint, exact package
versions and checksums. All six archives are deliberately retained in git (about 200 KB total).
They contain no credentials. API's `scripts/build-joint-conformance.mjs` produces them from the
real graph, CLI projection and built HTTP client. Generate twice and compare manifests before
replacing the retained set. Refresh this bundle whenever the API candidate changes relevant
contract, client or server behavior; compare `artifactSetHash` and every archive checksum, not only the base commit or server-only `producer.sourceHash`.

The strict consumer checks generated IDs, input locations, required fields, status/error narrowing
and the actual form binding with no server imports or type-escape casts. Node tests exercise real
HTTP 200/201/204, declared 404 details, validation, omitted/null/false forms and independent concurrent
Angular request injectors and deliberately overlapping SSR document renders. Approved cookies, request IDs, locales, HTML results and abort state stay per request.
Chromium runs the packed generated client and Angular adapter against the packed Hono server and
checks cross-origin JSON, declared errors/validation, request ID exposure, generated form submission, 204 and cancellation after server I/O begins. Node and browser run generated session.me → 401 → session.refresh → replay and sign-out; browser server captures verify the HttpOnly cookie reaches every session request.

This closes the available unary/form integration seam. It is not full completion of the broader
`JOINT_CONFORMANCE_PLAN` roadmap: backend SSE/socket, generated upload/download bindings, advanced
codecs and backend idempotency/retry still need their own real fixtures. Actual overlapping Angular SSR document renders are tested alongside independent request injectors; hydration and application-level caches remain app-specific. Supported and deferred capabilities remain in the manifest.
