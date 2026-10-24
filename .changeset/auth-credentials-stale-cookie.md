---
"@sixthsummit/ship-auth-credentials": minor
---

A stale session cookie (unknown, revoked, expired, idle, cut off or malformed) is now cleared and audited. `credentialActorResolver({ sessions })` / `credentialAuthentication({ sessions })` attach a clearing `Set-Cookie` to the resolution so the browser stops presenting the dead cookie whether the operation resolved anonymously or was refused, and record one `session.stale-cookie` audit row with the reason, the operation id and the known account and session when there is one. `StaleSessionReason` is exported.
