---
"@sixthsummit/ship-core": patch
"@sixthsummit/ship-hono": patch
"@sixthsummit/ship-contract": patch
"@sixthsummit/ship-angular": minor
---

Harden declared HTTP 3xx redirect results (SAPI-653). `defineOperation` rejects a
redirect output schema that cannot produce an empty body at definition time
(`SHIP_OPERATION_OUTPUT_INVALID`); the executor, Hono adapter and contract client keep
validating every result, so an unsafe `Location` (protocol-relative, credentials,
non-HTTP scheme, whitespace or control characters) or a redirect with a body is never
serialized and HTTP answers the safe 500 envelope without `Location`. The Hono matrix,
a compat-versus-kernel parity test and the contract suite now pin every redirect
status, `POST` to `303`, header pass-through, the `first-value` callback query policy
and failure redirects next to JSON declared failures. ShipAngular exposes `location`
on `ResponseMetadata`, reports an opaque browser redirect as `ProtocolError` with
reason `opaque-redirect` instead of inventing a status, and its packed conformance
fixture executes a declared `302` case.
