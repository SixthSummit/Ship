# eval-002-auth-adapter — add a capability-based Auth0 adapter

You are working in a generated ShipAngular application.

Generate `Auth0AuthAdapter` under `src/auth`, then replace the in-memory bodies with a
deterministic Auth0-shaped test double. Advertise only capabilities the adapter implements;
resolve the current bearer token on every token request; keep construction free of browser
I/O; and retain explicit `initialize`/`destroy` lifecycle hooks. Keep the generated
`runConformance` suite in a colocated `*.test.ts`.

## Success criteria

- The adapter implements `AuthAdapter` and exposes `Signal<AuthState>`.
- Optional actions are represented by `AuthAdapterCapabilities`, not placeholder methods.
- `runConformance` passes and includes a token-refresh-specific test.
- No token, password, or provider error is logged.
- `pnpm run ci` passes.
