# eval-008-session-auth — wire an operation-backed cookie session

You are working in a generated ShipAngular application with typed operations `auth.me`,
`auth.signIn`, `auth.refresh`, and `auth.signOut`.

Create one `OperationSessionAuthAdapter` and register it with `AuthService`. Map all session
actions to stable operation IDs and explicitly call `initialize` during bootstrap. Feed the
adapter's cookie credential capability into the same operation request policy used by unary,
upload, download, and stream transports. The current CSRF supplier must run per attempt and
SSR must forward only allowlisted session cookies/headers.

Do not duplicate ShipAPI credential behavior in Angular HTTP interceptors or construct auth
URLs. Add tests for valid/invalid bootstrap sessions, refresh rotation, current CSRF token,
abort, and two concurrent SSR requests with different cookies.

## Success criteria

- Session calls are structural operations and declared failures remain values.
- Bootstrap performs an explicit identity probe.
- One credential/request-policy pipeline serves every ShipAPI transport.
- Concurrent SSR request state cannot cross-contaminate.
- `pnpm run ci` passes.
