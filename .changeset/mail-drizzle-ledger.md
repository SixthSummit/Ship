---
"@sixthsummit/ship-drizzle": minor
---

Add the transactional mail send ledger: `shipMailSendsTable()` (`ship_mail_sends`, one row per idempotency key with addressed and delivered recipients, status, attempts, provider ids and timestamps; GIN-indexed recipients) and `createDrizzleMailLedger()` implementing the kernel `MailLedger` contract with an atomic claim that retakes failed rows and stale claims.
