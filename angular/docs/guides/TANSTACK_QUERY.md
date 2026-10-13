# TanStack Query

Use `/query` when views need shared cached server data, prefetch, or cursor pagination.
Keep `OperationClient` as the transport.
Use `/operations` resources when one owner needs one read and explicit reload.
Both APIs belong in ShipAngular. Neither API replaces the other.
Do not use the legacy overloaded `createResource()` for this integration.

This guide uses short instructions and consistent terms inspired by ASD-STE100.
It does not claim formal STE compliance.

## Dependency and ownership

ShipAngular supplies safe read bindings, operation adaptation, scope guards, and providers.
TanStack supplies query caching, observers, freshness, deduplication, and pagination.
The upstream Angular adapter is experimental. Its minor and patch releases can change APIs.
The verified candidate is `@tanstack/angular-query-experimental@5.104.1` with Angular 20.3.30.
Pin that exact version until the supported dependency range changes.
See the [upstream installation guidance](https://tanstack.com/query/latest/docs/framework/angular/installation).

Import ShipAngular features from `@sixthsummit/ship-angular/query`.
Applications that omit this entrypoint need no TanStack dependency.
This integration excludes Table, Router, Form, persistence, offline write replay, and automatic entity normalization.

## Terms

| Term         | Meaning                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| Read binding | Operation ID, safe-read declaration, input key mapper, and response variant key.   |
| Query key    | Values that identify one cached query.                                             |
| Scope        | Application namespace, identity boundary, and generation.                          |
| Generation   | Value that changes for each identity replacement, including same-key replacements. |
| Envelope     | Typed response body, complete operation result, and optional ETag.                 |
| Invalidation | Mark selected queries stale and refetch active queries.                            |

## Provide one browser lifetime

```ts
import { provideShipQuery } from '@sixthsummit/ship-angular/query';

export const queryProviders = [
  provideShipQuery({ namespace: 'catalog.v1', scopeKey: 'anonymous' }),
];
```

Register the provider once in the application injector.
The provider owns its `QueryClient`, native mount, scope, and cleanup.
Do not replace its injected native `QueryClient` with another client.
Use an opaque, non-secret scope key. Never put tokens, cookies, passwords, or bearer headers in keys.

The default `staleTime` is 30 seconds. The default browser `gcTime` is five minutes.
Per-query freshness options inherit provider defaults unless explicitly changed.
Reads refetch when stale on mount, window focus, and reconnect.
TanStack retries are always disabled. The operation policy owns retry attempts.
Do not add a second timeout or transport.

## Define safe reads

```ts
const detailBinding = defineShipReadBinding<ExampleContract>()({
  operationId: 'detail',
  safety: 'safe',
  inputKey: input => input.id,
  variantKey: 'example.v1',
});
```

Declare safety explicitly. A method name or HTTP method does not prove safety.
Map every response-affecting input field into the key.
Include locale or other response variants in `variantKey`.
Key values must be supported JSON values. Do not use functions, class instances, cyclic values, or secrets.
The mapper must be deterministic and must not mutate input.
Keep input immutable until its request settles.
The key contains namespace, scope key, generation, mode, operation ID, variant, and mapped input.
Finite and infinite keys have different modes.

## Read through guarded signals

```ts
const context = inject(SHIP_QUERY_CONTEXT);
const selectedId = signal<number | undefined>(1);
const detail = injectShipQuery(
  client,
  detailBinding,
  () => {
    const id = selectedId();
    return id === undefined ? undefined : { id };
  },
  context
);

const title = computed(() => detail.data()?.data.title);
```

Create the helper inside an Angular injection context.
Return `undefined` to disable a read. No input mapper or request runs for disabled input.
Use `data()`, `error()`, `isPending()`, and other native-style signals.
The helper hides old data, errors, flags, and timestamps immediately when the scope changes.
This guard also protects custom `select` results, including primitive values, and awaited `refetch()` results.
An options factory can read Angular signals for reactive freshness or selection.

The cache stores an envelope: `{ data, result, etag? }`.
Read the body through `query.data()?.data`.
Read status and response metadata through `query.data()?.result`.
A 204 response has an envelope even when its body is undefined.
A 304 response retains the prior body and records the complete new 304 result.
The separate `etag` field retains a validator when the 304 headers omit it.
Infinite reads do not send conditional ETags.

Declared operation failures become `OperationApiError` at the Query boundary.
The original failure and metadata remain available on that error.
Transport, abort, and protocol errors retain their original error identity.
Resource helpers instead retain expected failures as result values.

## Prefetch and advanced options

```ts
await context.queryClient.prefetchQuery(
  shipQueryOptions(client, detailBinding, { id: 2 }, context)
);
```

Prefetch shares the exact key used by component reads.
It does not expose a component signal.
Use `shipQueryOptions` or `shipInfiniteQueryOptions` for advanced native composition.
These builders do not mask a native observer's existing result after scope replacement.
For component access, use the guarded injection helpers.
If you compose a native observer directly, guard every exposed outcome with its captured scope.
Do not assume a reactive options update clears old data before Angular effects flush.

Caller options cannot replace keys, execution, hashing, retry, initial data, or placeholder data.
The adapter rejects protected options when callers bypass TypeScript.
Supported call controls include signal, headers, timeout, idempotency key, and keepalive.
Keepalive remains opt-in.

## Read cursor pages

```ts
const pages = injectShipInfiniteQuery(client, listBinding, () => ({ cursor: null }), context, {
  initialPageParam: null as number | null,
  buildInput: (_base, cursor) => ({ cursor }),
  getNextPageParam: page => page.data.next ?? undefined,
});

await pages.fetchNextPage();
```

Use a JSON-compatible page parameter. The initial page parameter is required.
Use `null` for an empty initial cursor. Undefined initial cursors are rejected.
Return undefined from `getNextPageParam` when the server reports the end.
Read envelopes through `pages.data()?.pages`. Read aligned cursors through `pageParams`.
The initial cursor forms part of the infinite key.
The guarded fetch methods enforce `cancelRefetch: false` to deduplicate concurrent triggers.
Advanced native callers must also pass `cancelRefetch: false` to page-fetch and refetch methods.

## Edit and roll back

Construct `shipMutationOptions(client, operation, context, config)` once.
The returned callable factory owns one operation mutation executor.
Pass the stable factory to `injectShipMutation(factory)`.
Do not reconstruct it in a reactive options factory.
See the compiled [workflow example](../../conformance/query-example/workflow.ts) for apply, rollback, and explicit invalidation.

Optimistic callbacks receive `effects.scope`, `effects.isCurrent()`, and `effects.run()`.
Capture prior envelopes before writing optimistic bodies.
Use `updateShipQueryData` inside `effects.run()` at each cache write, including writes after an await.
Rollback restores the prior envelope on a current-scope failure or cancellation.
Old-scope rollback must not write into a new scope.
Use `invalidateShipQueries` to invalidate explicit read targets after success. The adapter does not infer targets from entities or mutation names.

The default overlapping-mutation policy is `reject`.
`take-latest` is incompatible with an optimistic policy. The existing operation executor rejects that combination.
Use `take-latest` only for mutations without optimistic callbacks.
A view teardown detaches that view's observer. It does not destroy a shared factory.
The factory owner must call `factory.destroy()` when its lifetime ends.
Same-scope factory teardown cancels work and permits guarded rollback.
Scope replacement disables old effects and removes owned cached state.

Cancellation cannot reverse a server write.
A server can finish after client abort. Use server idempotency and refresh authoritative data when required.
The client suppresses late results and cache effects from an old generation.

## Replace identity or log out

Disable identity-specific input before replacing credentials or scope.
Then await `context.scope.change(nextNonSecretScopeKey)`.
Reads remain disabled during the cancellation barrier.
Each call advances generation, even when the scope key remains the same.
On logout, change to an anonymous scope before re-enabling anonymous reads.
Do not retain old envelopes in application-owned signals.
The controller cancels and removes its owned query and mutation prefixes.
It preserves unrelated application cache entries.

## Connect application-owned realtime events

The Query entrypoint does not open a realtime connection.
Use the application subscription described in [Realtime Subscriptions](REALTIME_SUBSCRIPTIONS.md).

1. Capture the scope when the listener starts.
2. Map each declared event to explicit read targets.
3. Before invalidation, check that the captured scope is current.
4. After reconnect or resubscription, invalidate all targets that could have changed.
5. If sequence numbers reveal dropped events, invalidate those targets again.
6. If the protocol cannot detect loss, refresh authoritative reads after reconnect.
7. On scope replacement or owner destruction, dispose listeners and close the owned subscription.

Sequence hints can reveal gaps. They are not durable replay cursors and do not prove complete delivery.
Treat events as freshness hints unless the application validates a complete replacement envelope.
Never invent successful response metadata from an event payload.
If an asynchronous listener resumes, check the captured scope again before writing.
Keep reconnect and backoff policy with the realtime transport.

## SSR lifetime and Angular stability

```ts
// Register separately in each SSR request injector.
provideShipQueryServer({ namespace: 'catalog.v1', scopeKey: requestScopeKey });
```

Provide the operation client's request context in the same request injector.
The server provider creates a fixed scope and request-owned QueryClient.
Never share that client across requests.
The request abort signal and injector teardown cancel work and clear the cache.
The server provider does not mount browser focus or online listeners.
Server automatic refetch is disabled. Explicit fetch and prefetch remain available.
There is no SSR cache transfer. The browser can repeat server reads.

The operation boundary can track Angular `PendingTasks`.
Its `trackPendingTasks: false` disables only that boundary's tracking.
`injectShipQuery` and `injectShipInfiniteQuery` delegate to upstream helpers, which independently track pending work.
These helpers add no further ShipAngular task handle.
`injectShipMutation` composes a native MutationObserver and adds no upstream `injectMutation` task handle.
Advanced use of upstream `injectMutation` introduces that separate upstream tracking.

## Controlled example and verification

The [example](../../conformance/query-example/README.md) uses one local typed fixture in both modes.
Change its delay, observe request counters, and trigger an edit rejection.
Baseline resources own separate reads. Query observers share keys and fresh envelopes.
The fixture uses no network service or credentials.
M6 must compile it against the physical package exports.
M7 must verify it against the packed consumer and the same operation contract.

## Strict package declarations

The Query package build uses the library's strict TypeScript configuration.
This also corrects the concrete `FirebaseAuthAdapter` and `MockAuthAdapter` bearer-token declarations.
Their `capabilities.bearerToken.getToken()` method returns `Promise<string | null>`.
The existing auth capability interface already allows `null`.
A signed-out adapter already returns `null` at runtime.

If code uses a concrete adapter, check the token before use:

```typescript
const token = await adapter.capabilities.bearerToken.getToken();
if (token === null) {
  return;
}
// Use the token only after this check.
```

This correction can reveal a missing null check during compilation.
It changes the declaration, not the adapter's runtime behavior.
