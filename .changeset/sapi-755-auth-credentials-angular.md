---
"@sixthsummit/ship-angular": minor
---

Add the `/credential-auth` entrypoint (SAPI-755): `provideShipCredentialAuth({ client, prefix?, storage? })`, the signal-first `ShipCredentialAuth` service over any structural operation client (sign-in through the MFA challenge and recovery steps, enrolment, sessions, reset and change-email, with declared failures and `Retry-After` kept as values), `ShipCredentialAuthContract` and `ShipAuthAuditContract` for typed clients, `memorySessionStorage`/`browserSessionStorage`, and the standalone `OnPush` `ShipSignInComponent`, `ShipMfaChallengeComponent`, `ShipRecoveryCodeComponent` and `ShipAuthAuditPanelComponent`.
