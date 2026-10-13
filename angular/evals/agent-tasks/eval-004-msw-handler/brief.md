# eval-004-msw-handler — mock an independent third-party REST API

You are working in a generated ShipAngular application.

Add an MSW `GET https://directory.example.test/users` handler returning at least one typed
user with `id`, `name`, and `email`. Exercise the handler through the application's generic
third-party REST client in a deterministic colocated `*.test.ts`. Do not route this API
through the ShipAPI operation client and do not attach ShipAPI cookies or bearer tokens.

## Success criteria

- The handler is registered for tests and opt-in local development.
- The test verifies the response body and that no authorization/cookie header is sent.
- Third-party REST remains independent from ShipAPI policy.
- `pnpm run ci` passes.
