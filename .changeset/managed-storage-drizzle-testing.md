---
"@sixthsummit/ship-drizzle": minor
"@sixthsummit/ship-testing": minor
---

Managed storage support (ADR-0022). `@sixthsummit/ship-drizzle` adds `shipStorageIntentsTable()`, `shipStorageObjectsTable()`, `shipStoragePurgesTable()` and `createDrizzleAttachmentLedger()`, whose claims use `FOR UPDATE SKIP LOCKED` and whose `attach`/`detach` join the executor's unit-of-work scope; include the tables in application migrations as a release step. `@sixthsummit/ship-testing` adds `createInMemoryStorageAdapter()`, `createInMemoryAttachmentLedger()` and the runner-agnostic `storageAdapterConformance()` suite under the `./storage` subpath.
