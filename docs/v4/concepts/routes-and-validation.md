# Operations, HTTP, and validation

ShipAPI defines HTTP as an adapter over a transport-independent operation. An
operation does not receive a Hono context and does not parse its own request.

## Declare the complete boundary once

```ts
const createNote = defineOperation({
  id: "notes.create",
  transport: http.post("/notes", {
    requestBody: http.body.json({ maxBytes: 32_768 }),
  }),
  input: { body: createNoteSchema },
  output: { 201: noteSchema },
  successStatus: 201,
  errors: [titleConflict],
  access: permission("notes:write"),
  transaction: "write",
  dependencies: { tx: notesUnitOfWork },
  handler: async ({ input, services, context }) =>
    services.tx.notes.create(input.body, context.actor.id),
});
```

The compiler can now inspect the stable ID, HTTP binding, bounded body policy,
input and output schemas, failure set, authorization, transaction, dependency,
and handler relationship as one graph node.

## Input validation

Input locations are named schemas such as `params`, `query`, `headers`, and
`body`. The executor runs every declared schema, aggregates safe validation
issues, and passes only normalized outputs to the handler. A schema may coerce or
transform; handler types reflect the output side while generated clients accept
the input side.

Unknown input locations and undeclared values are rejected. Validation failures
use the stable framework error code `VALIDATION_ERROR` and
`details.issues[{ path, message, code? }]` wire shape.

HTTP query parsing is strict by default: repeated scalar keys become arrays,
`name[]` encodes an array, and mixing `name` with `name[]` is rejected. An
operation that must preserve an existing first-value query contract can opt in:

```ts
http.get("/oauth/callback", {
  response: "redirect",
  queryParsing: "first-value",
});
```

In this mode each exact query key takes its first decoded value. For example,
`code=one&code=two&code[]=three` supplies `code: "one"`; `code[]` remains a
separate key. Declare the scalar fields in `input.query`. The selected policy
is recorded in the client contract and OpenAPI as `x-ship-query-parsing`.

The Hono adapter performs identity and access checks before reading a protected
body. An unauthenticated caller therefore cannot force JSON, raw, or multipart
materialization before receiving 401.

Some compatibility APIs distinguish an empty JSON request from an ignored
non-JSON body. Declare `http.body.json({ onEmptyJsonBody: "reject",
onNonJsonContentType: "ignore" })` for that boundary. After authorization, a
zero-byte request with a JSON media type receives the same `invalid_json`
validation failure as malformed JSON; a non-JSON body remains absent for the
operation schema. The default still treats an empty JSON body as absent.

## Explicit body limits

JSON defaults to the adapter's bounded limit and can declare a tighter one:

```ts
http.post("/notes", {
  requestBody: http.body.json({ maxBytes: 32_768 }),
});
```

JSON bodies normally require a JSON media type. A compatibility operation
whose previous HTTP route ignored non-JSON bodies can opt into the same
behavior without changing its JSON validation:

```ts
http.put("/legacy-notes/:id", {
  requestBody: http.body.json({ onNonJsonContentType: "ignore" }),
});
```

With this option, a body sent as `text/plain` or another non-JSON media type is
passed to the operation as absent input. JSON and structured `+json` media
types are still parsed and bounded. The default is `"reject"` and returns 415
for a non-JSON body. Declare an optional `body` input schema when using
`"ignore"`, and apply this policy only where the existing API contract requires
it. Ignored bodies are not read by the adapter, so an ingress-level request
size limit remains appropriate.

An operation whose previous route treated malformed JSON as an absent body may
separately opt into `onInvalidJson: "ignore"`. The default is `"reject"` and
returns a 400 validation error. This policy still enforces the configured body
size limit and JSON media type, and requires an optional body input schema:

```ts
http.post("/legacy-send", {
  requestBody: http.body.json({ onInvalidJson: "ignore" }),
});
```

Raw and multipart requests require explicit finite limits:

```ts
http.post("/imports", {
  requestBody: http.body.raw({
    maxBytes: 2_000_000,
    contentTypes: ["text/csv"],
  }),
});

http.post("/documents", {
  requestBody: http.body.multipart({
    maxBytes: 12_000_000,
    maxFiles: 1,
    maxFileBytes: 10_000_000,
    maxFields: 8,
    maxFieldBytes: 8_192,
  }),
});
```

These policies are part of the graph, contract manifest, generated-client
behavior, and OpenAPI. They cannot drift as route-only middleware.

## Access and transactions

Access policies are declarations:

- `publicAccess()` permits anonymous execution;
- `optionalIdentity()` exposes a verified identity when present;
- `authenticated()` requires an actor; and
- `permission()`, `allPermissions()`, and `anyPermission()` enforce stable
  permission slugs.

The same kernel check runs for direct and HTTP execution. Protected handler
contexts receive a required actor type.

`transaction: "read"` or `"write"` executes transaction-scoped capabilities
inside the unit of work. Expected declared failures roll back before becoming
result values. Immediate external effects are rejected inside a database
transaction; use a durable outbox capability and dispatch separately.

## Responses and expected failures

Success outputs are indexed by status. Return the declared default body or use
`respond(status, body, { headers })` for another declared status or metadata.
HTTP representations support JSON, text, binary, `204`, safe response headers,
content type, content disposition, ETag, retry metadata, and request ID.

Expected application failures use `operationError()` and
`operationFailure()`. Undeclared throws become a safe internal failure and do not
leak their message. Direct execution, Hono, OpenAPI, and the default client share
the same status/error contract.

## Projection, not registration

```ts
export const app = defineApp({ id: "notes-api", modules: [notesModule] });
export const httpApp = createHonoAdapter(app, { auth });
```

`createHonoAdapter()` reads the compiled graph and creates routes. There is no
second route registry to keep synchronized. Compiler diagnostics reject invalid
or colliding bindings before startup.

Run direct/Hono differential tests for every behavior that could diverge at the
transport boundary: normalized inputs, auth outcomes, declared errors, status,
body representation, and response metadata.

## Compatibility route APIs

The monolithic package continues to support `createApp()`, Hono route chains,
`validate()`, `requireAuth()`, `requirePermission()`, the development route
registry, and `hc<typeof app>()` while current v4 clients migrate. Do not mix
those registrations into the operation graph or make them the source for new
contracts.
