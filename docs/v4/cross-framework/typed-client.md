# Typed operation client

ShipAPI's target client contract is the compiled operation graph—not Hono's chained route type. One operation declaration now drives direct execution, Hono routing, a deterministic client manifest, OpenAPI, and the default Fetch client.

The older `hc<typeof app>()` client remains available through `@sixthsummit/ship-api/client` during the v4 transition. Treat it as a compatibility surface, not the architecture for new integrations.

## Declare the contract once

```ts
const accountNotFound = operationError({
  code: "ACCOUNT_NOT_FOUND",
  status: 404,
  message: "Account not found",
  details: z.object({ accountId: z.string() }),
});

const readAccount = defineOperation({
  id: "accounts.read",
  transport: http.get("/accounts/:accountId"),
  input: { params: z.object({ accountId: z.string().uuid() }) },
  output: { 200: z.object({ accountId: z.string(), name: z.string() }) },
  successStatus: 200,
  errors: [accountNotFound],
  access: permission("accounts:read"),
  transaction: "read",
  dependencies: { database },
  handler: async ({ input, services }) => {
    // Return the declared success body or throw operationFailure(accountNotFound, ...).
  },
});
```

The stable operation ID is the client method identity. URLs and module layout may change without renaming frontend call sites. Input locations, success statuses, declared errors, access policy, and representation metadata remain mechanically inspectable.

Framework-owned error codes are reserved so an application error cannot silently collide with validation, authentication, authorization, media, payload, or internal failures.

## Emit reproducible artifacts

Export the compiled application as `app` from `ship.config.ts`, then run:

```bash
ship-api contract \
  --app ship.config.ts \
  --out .ship/contract.json \
  --typescript .ship/contract.ts \
  --openapi .ship/openapi.json \
  --openapi-title "Accounts API" \
  --api-version 4.0.0
```

All three artifacts are deterministic and come from the same compiled declarations. `contract.json` is the manifest; the TypeScript contract preserves the literal manifest and derives an `AppContract` from its JSON Schemas; OpenAPI documents the same operations. Each file changes only where an operation changed, so two branches that edit different operations merge without conflicts.

None of the files stores a digest of itself. The command prints one (`OK <appId> sha256:…`, or `fingerprint` in `--format json`), and `fingerprintClientContract()` from `@sixthsummit/ship-contract/project` computes the same value from a loaded contract when a build wants a label or a cache key.

### Verify in CI

Regenerate and diff. A stale or hand-edited artifact shows up as a difference against what the declarations produce:

```bash
ship-api contract --app ship.config.ts --api-version "$API_VERSION"
git diff --exit-code -- .ship/
```

Wire that pair as the application's `contract:verify` script and run it in the pull-request gate. After merging two branches, run `ship-api contract` once more; the merged declarations are authoritative and the diff must be empty.

### Upgrading from a stored fingerprint

Contracts emitted before `@sixthsummit/ship-contract` 1.6 carried `fingerprint: "sha256:…"` in `contract.json` and `contract.ts`, and OpenAPI carried `x-ship-contract-fingerprint`. Every regeneration rewrote that line, so any two open pull requests conflicted on it as soon as one merged.

1. Upgrade `@sixthsummit/ship-contract` and `@sixthsummit/ship-cli` together, and `@sixthsummit/ship-angular` to a version that accepts a manifest without the field (its `ShipApiClientContractManifest` and `ShipStreamManifest` types list `fingerprint` as optional).
2. Run `ship-api contract` once and commit the three files. This is the only regeneration the upgrade needs; the diff removes the fingerprint lines and nothing else.
3. Copy the files to the frontend as before.

Until that regeneration lands, every client keeps loading the committed contract: `createHttpOperationClient` and the ShipAngular adapters accept the field when present (and still reject a malformed one) and do not require it. Code that read `contract.fingerprint` should call `fingerprintClientContract(contract)` instead.

The generated client contracts intentionally contain no handlers, provider implementations, database types, credentials, or observability configuration. Compile `.ship/contract.ts` into an application-owned browser package or copy it through a deterministic build step; do not import the server application to recover its types.

## Call by operation ID

For a co-located TypeScript application, the backend-only application type remains available:

```ts
import {
  createHttpOperationClient,
} from "@sixthsummit/ship-contract";
import type { ApplicationContractOf } from "@sixthsummit/ship-contract/application";
import type { app } from "./ship.config.js";
import contract from "./.ship/contract.json" with { type: "json" };

const client = createHttpOperationClient<ApplicationContractOf<typeof app>>(contract, {
  baseUrl: "https://api.example.com",
  credentials: "include",
});

const result = await client.call("accounts.read", {
  params: { accountId },
});

if (result.ok) {
  console.log(result.data.name, result.requestId);
} else if (result.error.code === "ACCOUNT_NOT_FOUND") {
  showMissing(result.error.details?.accountId);
}
```

`OperationClient<TContract>` is structural. A separately packaged `.ship/contract.ts` satisfies `OperationTypeContract` without importing the server app, Hono, Drizzle, or Node runtime. The generated file is the cross-repository type artifact; never replace it with handwritten frontend DTOs.

## Result and exception rules

Expected API outcomes are values:

- declared application failures;
- framework validation, authentication, authorization, payload, media, and availability failures;
- every declared 2xx result, including `204`;
- response status, request ID, headers, retry metadata, ETag, content type, and disposition.

An HTTP redirect is declared explicitly with `http.get(path, { response: "redirect" })`,
`output: { 302: z.undefined() }`, and `successStatus: 302`. The handler must return
`respond(302, undefined, { headers: { Location: url } })`. Supported statuses are
301, 302, 303, 307, and 308. Ship validates that the response has no body and
that `Location` is an HTTP(S) URL or root-relative path without control
characters. The contract and OpenAPI show an empty 3xx response with a required
`Location` header.

The Fetch client uses `redirect: "manual"` for these operations so a runtime that
exposes the 3xx returns `result.metadata.location`. Browsers may instead expose
an opaque redirect with no status or headers; the client throws
`SHIP_CLIENT_REDIRECT_OPAQUE` in that case. For a browser OAuth callback flow,
navigate the browser to the endpoint and let the browser follow the redirect;
do not call it through Fetch when the application needs to complete navigation.

These remain exceptional:

- network failure or cancellation;
- an unknown operation or invalid call input;
- a missing or failed client codec;
- malformed, uncorrelated, undeclared, or otherwise protocol-invalid responses.

The client preserves unknown additive error fields. Code should switch on durable error codes, never message text.

## Serialization

- Path parameters are URI encoded.
- Scalar query values use ordinary `name=value` encoding.
- Query arrays use bracket keys: `tag[]=one&tag[]=two`.
- An empty query array is represented by a key without `=`: `tag[]`; `tag[]=` means an array containing one empty string.
- The Hono adapter continues to accept repeated legacy keys such as `tag=one&tag=two`.
- Mixing scalar/repeated and bracket forms for the same key is rejected as ambiguous.
- Request bodies are JSON. `204` has no body. Success representation is explicitly `json`, `text`, or `binary` with one declared media type.

Nested query objects are not guessed. Model them as flat fields, move them into a body where appropriate, or add a future explicit codec contract.

Dates, decimals, big integers, branded wire values, and non-Zod schemas require explicit metadata:

```ts
const date = contractSchema(z.date(), {
  jsonSchema: { type: "string", format: "date-time" },
  codec: "date.iso",
});
```

Configure that named, browser-safe codec on the client. Server validation remains authoritative; JSON Schema is the portable projection for clients and OpenAPI.

## Package boundaries

- `@sixthsummit/ship-contract` is the browser/edge-safe client runtime and structural types.
- `@sixthsummit/ship-contract/application` is the backend-only `ApplicationContractOf<TApp>` convenience type.
- `@sixthsummit/ship-contract/project` projects the deterministic manifest and uses Node hashing.
- `@sixthsummit/ship-contract/openapi` projects OpenAPI at build time.
- `@sixthsummit/ship-contract/schema` supplies server-side schema metadata and Zod projection.
- `@sixthsummit/ship-api/client` remains the legacy Hono `hc()` compatibility entry.

Do not import projector subpaths into browser code. The edge and packed-consumer gates enforce this boundary.

## Cross-framework ownership

The default client owns HTTP serialization, response parsing, codecs, and protocol diagnostics. ShipAngular owns dependency injection, signals/resources, SSR request scoping, auth credential supply, presentation errors, and UI retry policy around the structural `OperationClient` seam.

See [ADR-0009](../../rearchitecture/decisions/0009-client-safe-contract-projections.md).
