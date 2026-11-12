---
"@sixthsummit/ship-contract": minor
"@sixthsummit/ship-cli": minor
---

Keep the transaction declaration out of the client contract so server-only changes leave the committed artifacts alone.

`projectClientContract` no longer copies an operation's `transaction` (mode, isolation, retry) into the manifest and `projectOpenApi` no longer emits `x-ship-transaction` by default: that is executor policy no browser client acts on, and carrying it meant that moving an operation onto the unit of work or tuning its isolation or retry regenerated `.ship/contract.json`, `.ship/contract.ts` and `.ship/openapi.json` for every frontend. Changing a declaration now produces no diff in the three files and does not change the contract fingerprint. The compiled graph keeps the resolved policy per operation (`ship-api check --emit`, `ship-api inspect operation <id>`), and an operator-facing OpenAPI document opts back in with `projectOpenApi(app, { includeServerMetadata: true })` or `ship-api contract --include-server-metadata`, which adds `x-ship-transaction` and nothing else. `ClientContractOperation.transaction` is now optional and `createHttpOperationClient` accepts an operation with the mode string, with the resolved policy, or without the field (a malformed value is still rejected), so already-committed contracts keep loading; regenerate once after upgrading to drop the lines.
