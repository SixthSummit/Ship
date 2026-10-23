---
"@sixthsummit/ship-hono": minor
---

`createHonoAdapter({ preValidationPolicies })` accepts a `"*"` key (`GLOBAL_PRE_VALIDATION_POLICY`) whose policy runs for every projected operation ahead of the operation's own policy; both must allow and their response headers merge. A policy may now deny with `{ allowed: false, reason: "invalid-credential" | "forbidden", message? }`, projected exactly like the actor resolver's refusals (401 `AUTHENTICATION_ERROR`, 403 `AUTHORIZATION_ERROR`), so a transport guard such as a CSRF check needs no per-operation declared error and never surfaces as a 500. `Set-Cookie` headers from an operation's `respond()` and from policy headers are appended instead of overwriting each other.
