# ADR-0004: Separate credentials, actors, and operation access

- **Status:** Accepted
- **Date:** 2026-09-03
- **Scope:** Authentication adapters, actor resolution, authorization, and audit input
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md)

## Context

Authentication currently lives primarily in Hono middleware. That shape can verify credentials and attach an account to one HTTP request, but it cannot protect direct operation execution by itself. It also mixes three distinct concerns: extracting transport credentials, resolving an authenticated account, and deciding whether that account may invoke an operation.

The existing `AuthProvider` interface is a useful compatibility surface, but its domain account exposes an optional asynchronous `hasPermission()` method. Passing that mutable account through every layer would couple the kernel to consumer entities and make authorization behavior depend on which transport invoked it.

## Decision

Credential extraction, actor resolution, and access enforcement are separate boundaries:

1. A Hono credential adapter extracts typed credential evidence from a Fetch `Request`.
2. A transport-independent actor resolver receives that evidence plus the operation ID, declared access, request ID, and cancellation signal.
3. The resolver returns either anonymous access, a minimal actor with a complete permission snapshot for this invocation, or one stable rejection reason.
4. The operation executor authoritatively enforces authenticated and all/any permission access against that actor snapshot.

The Hono adapter performs the same access check before parsing a protected request body, then passes the actor to the executor, which checks again at the operation boundary. This early check limits unauthorized work; it does not replace kernel enforcement.

`publicAccess()` is also the optional-auth declaration. A missing credential may continue anonymously, a valid credential may supply an actor, and a present invalid credential is rejected. There is no second optional-auth flag that can disagree with operation access.

Actor objects contain only a stable ID and an immutable permission snapshot. Handlers do not receive provider tokens, raw headers, or a mutable consumer account. Additional identity data must enter through an explicit typed capability when a use case proves it is required.

Actor resolution failures map as follows:

| Resolution | HTTP status | Code |
|---|---:|---|
| Invalid credential | 401 | `AUTHENTICATION_ERROR` |
| Authenticated but forbidden/unknown actor | 403 | `AUTHORIZATION_ERROR` |
| Resolver/provider unavailable | 503 | `AUTHENTICATION_UNAVAILABLE` |

Unexpected or malformed adapter results remain safe internal failures. Provider messages and credential values are never copied into the wire response.

`honoAuthProvider()` adapts current v4 `AuthProvider` implementations to this boundary. It verifies and resolves the account, evaluates only the permissions declared by the target operation, and snapshots the granted set. This is a migration bridge, not the new kernel contract.

## Consequences

- Direct, HTTP, test, CLI, and future job execution share one authorization rule.
- Credential parsing remains transport-owned while actor resolution can be reused by other transports.
- Resolvers receive stable audit correlation input without depending on ambient request context.
- Unauthorized HTTP requests are rejected before JSON parsing, schema validation, provider construction, or handler work.
- Permission evaluation happens once during actor resolution and becomes deterministic for the invocation.
- Consumers that need rich account data must request a typed service/capability rather than casting the security principal.
- The v4 compatibility bridge may perform multiple `hasPermission()` calls per operation; a native resolver can load or compute one permission snapshot more efficiently.

## Rejected alternatives

### Keep authorization only in Hono middleware

Rejected because direct execution and future transports could bypass it.

### Put raw credentials or the provider account on operation context

Rejected because it leaks transport secrets and consumer entity types into the kernel and makes permission behavior mutable during execution.

### Call `hasPermission()` from the executor

Rejected because the kernel would own asynchronous consumer policy lookup and could repeat it across transport and execution checks. A per-invocation snapshot keeps execution deterministic.

### Treat invalid credentials as anonymous on public operations

Rejected because a present invalid or revoked credential should not silently downgrade into an anonymous request.
