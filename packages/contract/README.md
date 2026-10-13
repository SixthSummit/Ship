# `@sixthsummit/ship-contract`

The portable boundary between ShipAPI backends and their consumers. It provides
a browser-safe structural HTTP client and JSON contract types from the default
entry, with backend-only application, schema, contract, and OpenAPI projectors
on explicit subpaths.

ShipAngular should consume generated `.ship/contract.json` artifacts and the
client entry. It should not import a Hono application type or backend source.

Adapters that accept the default client should use `OperationClient<TContract>`
or its `OperationClientCall<TContract>` call signature from `@sixthsummit/ship-contract/client`.
Redeclaring the generic `call` method independently can force TypeScript to
expand a large generated contract during structural comparison. The shared
signature preserves operation-specific inputs and results, rejects undeclared
input locations, and distinguishes unary promises from synchronous stream handles.

## Streaming operations

Operations whose manifest entry carries `response: { mode: "stream", framing: "sse", frame, terminal, limits }`
return a synchronous `OperationStreamHandle` from `client.call()` instead of a promise:

```ts
const handle = client.call("reports.progress", { params: { reportId }, body: { steps: 3 } });
for await (const frame of handle.frames) render(frame);        // typed by response.frame
const summary = await handle.terminal;                          // typed by response.terminal, undefined on error
if (handle.status === "error") report(handle.error);            // { code, status, message, details? }
handle.abort();                                                 // cancels the request
```

The handle is built on Fetch and `ReadableStream` with the browser-safe SSE parser exported as
`createSseParser()`. Errors before the first frame (JSON envelopes), terminal `error` events, and
interrupted connections (`STREAM_INTERRUPTED`, `status: 0`) all surface as `status`/`error` values;
only client-side misuse rejects. The exact wire and manifest contract is documented in
[`docs/v4/streaming.md`](../../docs/v4/streaming.md).

Inbound webhook operations are provider-facing: `projectClientContract`
excludes them (and their presence leaves the manifest fingerprint unchanged),
`ApplicationContractOf` omits them, and `projectOpenApi` documents them with
the raw media types and the kernel's webhook facts under `x-ship-webhook`.
