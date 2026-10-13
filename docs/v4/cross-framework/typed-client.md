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

All three artifacts are deterministic and come from the same compiled declarations. `contract.json` includes a SHA-256 fingerprint; the TypeScript contract preserves the literal manifest and derives an `AppContract` from its JSON Schemas; OpenAPI embeds the same fingerprint. CI can regenerate and diff these files to detect drift.

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
