# ShipAngular ↔ ShipAPI Contract

> **Superseded on 2026-09-03 by [ADR 0002](decisions/0002-operation-client-contract.md).** This document is preserved as the historical v4 Hono contract and remains relevant only to the temporary compatibility adapter and pinned clients. New ShipAPI integration work targets the structural operation client.

> **Status:** locked for the 4.0 line. Decision recorded here so it doesn't get relitigated.
> **Audience:** framework contributors and AI agents extending ShipAngular and/or ShipAPI.
> **Specific library resolved 2026-05-08:** TypeScript-RPC = **Hono `hc()` typed client** (matches ShipAPI v4 alpha). See [Resolution](#resolution-2026-05-08-hono-hc) below.

## Decision

**TypeScript-RPC is the primary contract between ShipAngular and ShipAPI. OpenAPI is a secondary export from ShipAPI for non-TypeScript consumers.**

ShipAngular's `createResource()` primitive (Phase 1a) is designed against this contract. The same primitive supports **REST URL/factory** for third-party APIs (Stripe, Resend, anything you don't own) — both call shapes ship in 4.0 GA via Phase 7's lock-step alignment with ShipAPI v4.

## Rationale

### Why TypeScript-RPC primary

1. **Agent-friendliness without codegen.** Agents don't have to remember to run a codegen step after schema changes. Types flow automatically through the RPC client, and the build is hermetic. The Agentic Operations narrative is undermined the moment "remember to run a generator" is the framework's primary integration step.
2. **TypeScript end-to-end.** Drizzle's type inference is best-in-class. Passing those types through to the frontend without ceremony is the highest-DX path available, and ShipAPI's whole point is to make that clean.
3. **Agency-client velocity.** Agency teams shipping fast want zero-ceremony. RPC is zero-ceremony; OpenAPI requires a codegen step and a build artifact to manage.
4. **Optional broadening.** OpenAPI export from ShipAPI can be added later as a secondary surface for non-Angular consumers (Swift, Kotlin, Python data teams) without disturbing the primary contract.

### Tradeoffs accepted

- **TypeScript on both ends of the primary path.** Mobile and data teams consume the secondary OpenAPI export (when it ships in ShipAPI), not the primary RPC.
- **The original wire-format question is now resolved** — see [Resolution](#resolution-2026-05-08-hono-hc) below. Hono's `hc()` is the locked choice. The historical phrasing of this section ("doesn't mean adopting tRPC literally — could be our own thin RPC layer") is preserved for context: at decision time, ShipAPI v4's design wasn't finalized; this document locked the _contract style_ (TypeScript-end-to-end, no codegen) ahead of the wire format.

### Rejected alternatives

- **GraphQL.** Too much ceremony for the agency-client workflow. Drizzle's GraphQL story is weaker than Prisma's was. Keeps the door open for `modules/graphql` as a roadmap stub for teams that need it, but not the primary contract.
- **OpenAPI as primary contract.** Viable. Slower iteration, looser type fidelity at the boundaries, codegen step is friction for agents. Reserved for the secondary export surface only.

---

## What this means in practice

### `createResource()` — two call shapes, both ship in 4.0 GA

```ts
// REST — URL/factory overload (any HTTP backend, including third-party APIs):
const users = createResource<User[]>(() => `${env.apiBase}/users?limit=10`, { method: 'GET' });
// users.value() is Signal<User[] | undefined>.

// Hono RPC — async thunk overload (paired with ShipAPI v4):
import { api } from '@/api'; // your hc<ShipApiClient>() instance
const users = createResource<User[]>(async () => {
  const res = await api.users.$get({ query: { limit: '10' } });
  if (!res.ok) throw await ApiError.fromResponse(res);
  return res.json();
});
// Types flow from ShipAPI's Drizzle schema → drizzle-zod → validate("json") → c.req.valid → hc<ShipApiClient>.
// No codegen step.
```

The public surface is identical regardless of underlying transport: `{ value, status, error, reload }`. Components don't change shape based on backend choice. See [`docs/INTERIM_BACKEND.md`](../INTERIM_BACKEND.md) for the worked end-to-end Hono integration example.

### `modules/forms` — schema-aware in 4.1

`modules/forms` ships in 4.0 with the typed-form components (Input/Select/Textarea/Checkbox/FileUpload) and the schema-driven `createSchemaForm(schema)` API that consumes a Drizzle/Zod schema from ShipAPI's API package and generates a typed `FormGroup` with validators derived from the schema constraints. See `modules/forms/MODULE.md`.

### `modules/billing` — frontend redirect + ShipAPI webhooks

Stripe Checkout and the customer portal are frontend redirect flows by design (always have been). The frontend module redirects directly to Stripe; ShipAPI handles webhooks and persists subscription state. The split is unaffected by the ShipAngular ↔ ShipAPI contract decision because Stripe Checkout was never going to be an RPC call.

### Migration tooling

When ShipAPI v4 is GA, ShipAngular's `migrate-to-v4` skill (Phase 7) and `ng update` codemods will help apps using the REST fallback move to RPC. Both paths remain supported permanently — REST is the right fit for third-party APIs that aren't ShipAPI.

---

## Resolution (2026-05-08): Hono `hc()`

The original decision deliberately deferred the specific wire format to ShipAPI v4's design phase. ShipAPI v4 has now landed on **Hono v4 + the `hc()` typed client** for the primary contract. This section captures what that means for ShipAngular, so the open phrasing earlier in this document doesn't get re-litigated.

### What ShipAPI ships

- `@sixthsummit/ship-api/client` re-exports Hono's `hc`, `InferRequestType`, `InferResponseType`. No tRPC, no custom RPC layer.
- Consumer's API package exports `type ShipApiClient = typeof wired` after all module routes are registered. ShipAngular type-imports it: `import type { ShipApiClient } from '@my-org/api'`.
- Error envelope: `{ success: false, error: { code, message, details } }`. Clients switch on `error.code` (durable string codes from `AppError` taxonomy).
- Validation: Zod schemas via `validate("json", schema)` middleware on the server.
- Status-narrowed responses: `hc()` types the response object by HTTP status code, so `if (res.ok) { ... }` narrows to the success body.
- OpenAPI export: still on the ShipAPI v4.x roadmap, not yet implemented.
- Canonical integration doc on the ShipAPI side: `ship-api/docs/v4/cross-framework/shipangular.md`.

### What this means for ShipAngular (Phase 7 — landed in 4.0 GA)

- **`createResource()` ships both call shapes:** URL/factory (REST, any backend) and async thunk (`() => Promise<T>` — wraps any `hc()` call). Additive, non-breaking.
- **`provideShipApiClient<T>()`** provides `hc<ShipApiClient>()` through Angular DI with SSR-aware request-scoped wiring. `inject(SHIP_API_CLIENT)` from any service.
- **`ApiError` / `RateLimitError`** map ShipAPI's `{ success: false, error: { code, message, details? } }` envelope. `instanceof ApiError`, switch on `.code`.
- **`createStream` / `createSocket` / `createUpload` / `createSignedUpload`** cover the SSE / WebSocket / multipart-upload / signed-URL surfaces ShipAPI exposes.
- **`SessionAuthAdapter`** is the cookie-session counterpart to `FirebaseAuthAdapter` — pairs with ShipAPI's dual-cookie JWT flow + optional CSRF.
- **Functional interceptors** (`idempotencyInterceptor`, `rateLimitInterceptor`, `csrfTokenInterceptor`, `requestIdInterceptor`) align with ShipAPI middleware features. Each ships a `withX(fetch)` wrapper for `hc()` integration since Hono's typed client uses raw fetch and bypasses Angular's HTTP_INTERCEPTORS.
- **OpenAPI codegen for third-party REST APIs is still on the roadmap** (`docs/ROADMAP.md`) — explicitly **not** the ShipAngular ↔ ShipAPI integration path. Use it for non-ShipAPI services that publish an OpenAPI document.

See [`docs/architecture/AUTHENTICATION.md`](AUTHENTICATION.md) for the auth-interceptor caveat, and [`docs/INTERIM_BACKEND.md`](../INTERIM_BACKEND.md) for the worked end-to-end integration example.

### Pending — flag, not a blocker

ShipAPI's `cross-framework/shipangular.md` example uses `posts.loading()` and `posts.refetch()`. ShipAngular's actual public API is `posts.status()` and `posts.reload()` (locked by `public-api.ts`). The mismatch is on the ShipAPI side; track via a separate ship-api PR.

---

## Action items (from this decision)

- [x] Write this document (Phase 0).
- [x] `createResource()` Phase 1a — REST URL/factory shipped; thunk overload shipped in Phase 7.
- [x] `modules/forms` schema-driven `createSchemaForm` (Phase 7).
- [x] `docs/INTERIM_BACKEND.md` walks the REST and Hono integration patterns.
- [x] **Phase 7 lock-step landed:** `createResource()` thunk overload, `provideShipApiClient()`, `ApiError` / `RateLimitError`, `createStream` / `createSocket` / `createUpload` / `createSignedUpload`, `SessionAuthAdapter`, `OnlineService`, four functional interceptors with `withX(fetch)` wrappers, three schematics (`:api-client`, `:stream`, `:upload`), two skills (`migrate-rest-to-hono`, `connect-shipapi`).

## Re-litigation policy

Don't. Read this document, the rationale, the rejected alternatives, and the [Resolution](#resolution-2026-05-08-hono-hc). If you have new information that overturns the decision (e.g., a major Drizzle/GraphQL rapprochement, or a TypeScript-language-level shift that changes the codegen calculus), open an ADR proposing the change. Do not silently adjust `createResource()` to assume a different contract — every consumer relies on the shape locked here.
