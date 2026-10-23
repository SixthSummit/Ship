---
"@sixthsummit/ship-angular": minor
---

`/credential-auth`: `ShipCredentialAuth.changePassword(currentPassword, newPassword, signOutOtherSessions = true)` calls `auth.change-password`, adopts the rotated session the server returns (a bearer client stores the new token; a cookie client keeps the cookie the response installed) and drops the other sessions from `sessions()` when they were signed out. The contract gains `auth.change-password`.
