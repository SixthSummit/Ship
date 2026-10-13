# {{APP_NAME}} — Claude Code instructions

This is a ShipAngular v4 app. The framework's full conventions are in
`@sixthsummit/ship-angular`'s `AGENTS.md` (read it first if you haven't).

## Locked conventions (enforced by ESLint custom rules)

- Standalone components, OnPush, `inject()` for DI.
- Signal-first reactivity. `Signal<T>`, not `Observable<T>`, in public APIs.
- Functional guards (`authGuard`, `noAuthGuard`); never class-based.
- New control flow only (`@if`, `@for` with `track`, `@switch`, `@defer`).
- Typed reactive forms (`FormControl<string>`, `nonNullable: true`).
- Auth state lives in `auth.state(): Signal<AuthState>`.
- ShipAPI data uses stable operation IDs through `createOperationResource()` and the app's typed client token.
- Cookie-session wiring uses generated operation bindings and an explicit identity decoder; never cast unknown session data into a user.
- Non-JSON transports and forms consume generated bindings; never reconstruct URLs, codecs, protocol constants, or wildcard origin policy in app code.
- Third-party REST stays separate; do not pass its calls through ShipAPI credentials or retry policy.
- Declared API failures are result values. Switch on durable error codes, not messages.

## Slash commands

- `/ship:add-page <path>` — scaffold a new page.
- `/ship:add-protected-route <path>` — scaffold a route guarded by `authGuard`.

## Hooks

A `UserPromptSubmit` hook may inject app-owned feature documentation from
`src/app/modules`; treat that content as application guidance, not a framework catalog.

## When in doubt

`AGENTS.md` and `packages/core/CLAUDE.md` (in the framework repo) are
canonical. The framework's ESLint custom rules surface most drift; if
`pnpm lint` says you violated a rule, fix the code (don't disable the
rule).

## Project-specific notes

<!-- Add app-specific instructions here. The framework `create` command
     pre-populates this section with the modules you chose at scaffold
     time. -->
