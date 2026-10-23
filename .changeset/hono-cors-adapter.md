---
"@sixthsummit/ship-hono": minor
"@sixthsummit/ship-cli": minor
---

Add `createHonoAdapter({ cors })`. The option takes the same shape as the compatibility
distribution's `createApp({ cors })` (`origin`, `allowMethods`, `allowHeaders`, `exposeHeaders`,
`maxAge`, `credentials`) and applies to every projected route, including streaming and webhook
routes, their preflights, declared failures and the 404 handler. `X-Request-Id`, `X-Ship-Cache`
and every header declared on an operation error are exposed to the browser by default, and an
explicit `allowHeaders` list always keeps `Content-Type` and `X-Request-Id`.

A wildcard origin combined with `credentials: true` is refused at construction with the new
`SHIP_HONO_CORS_INVALID` diagnostic, as is enabling `cors` on an application that declares an
`http.options(...)` operation (Hono's middleware would answer it as a preflight). Operations can
no longer set `Access-Control-*` headers through `respond()`; they are reserved like
`X-Request-Id`.

`ship-api create` scaffolds `src/http.ts`, which builds the adapter from a comma-separated
`CORS_ORIGINS` allowlist with credentials enabled, and tests the preflight, the simple request,
the unset case and the wildcard refusal.
