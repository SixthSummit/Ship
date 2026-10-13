# React Native and Expo consumption

React Native consumes the same browser-safe structural operation client as web
applications. TanStack Query or another state library wraps stable operation IDs
and discriminated results; it does not recreate request serialization.

```ts
const client = createHttpOperationClient<AppContract>(contract, {
  baseUrl: process.env.EXPO_PUBLIC_API_URL!,
});

const token = await session.currentToken();
const result = await client.call("accounts.read", {
  params: { accountId },
}, {
  headers: { authorization: `Bearer ${token}` },
});
```

The current client options accept a static header map. A mobile auth integration
must supply fresh credentials through an approved wrapper/call pipeline rather
than capturing a token at application startup.

## Query integration

Use the operation ID plus normalized input as the cache key. Preserve the full
result and response metadata:

```ts
useQuery({
  queryKey: ["accounts.read", accountId],
  queryFn: async ({ signal }) => {
    const result = await client.call(
      "accounts.read",
      { params: { accountId } },
      { signal },
    );
    if (!result.ok) throw toPresentationError(result);
    return result.data;
  },
});
```

Only the presentation adapter should throw declared failures. The structural
client keeps them as values with status, code, details, request ID, and headers.

## Mobile boundaries

- Propagate cancellation from Query and screen lifecycle through `AbortSignal`.
- Retry reads conservatively; never retry a mutation without an explicit
  idempotency contract.
- Re-evaluate auth credentials on refresh and reconnect.
- Keep secrets in platform-secure storage, never Expo public environment values.
- Treat offline state as a frontend concern and preserve typed stale data.
- Do not import backend application, Hono, Drizzle, or Node-only packages.

## Multipart uploads

React Native's `FormData` file shape differs from browsers. A mobile adapter may
translate `{ uri, name, type }`, but it must still use the shared auth, CSRF,
idempotency, request-ID, abort, and result pipeline. Do not set the multipart
`Content-Type` boundary manually. Client checks improve UX; server-declared total,
file, count, and field limits remain authoritative.

## Binary downloads

Keep binary success distinct from the normal JSON error envelope. Preserve exact
bytes, status, MIME type, disposition, filename, request ID, and retry metadata.

## Streaming and sockets

The kernel declares streaming responses and realtime publication in separate
contracts (ADRs 0016 and 0017). A mobile integration must explicitly cover typed event
or message schemas, close/completion semantics, reconnect, current auth on
reconnect, and cancellation. Never put bearer credentials in query parameters.

## Compatibility window

Existing RN/Expo apps may retain `hc<typeof app>()` while the generated
application-contract package and shared client fixture are finalized. New
integration code should be kept behind a structural client/resource seam so the
compatibility adapter can be removed without rewriting every screen.
