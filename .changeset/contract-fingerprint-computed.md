---
"@sixthsummit/ship-contract": minor
"@sixthsummit/ship-cli": minor
---

Stop storing the contract's fingerprint in the emitted artifacts so unrelated regenerations merge cleanly.

`projectClientContract` no longer writes `fingerprint: "sha256:…"` into the manifest and `projectOpenApi` no longer emits `x-ship-contract-fingerprint`; `ship-api contract` therefore emits `.ship/contract.json`, `.ship/contract.ts` and `.ship/openapi.json` without a line that changes on every regeneration, and two branches that change different operations three-way merge without conflicts. The digest is still available: `fingerprintClientContract(contract)` from `@sixthsummit/ship-contract/project` computes the same SHA-256 the file used to carry (a legacy `fingerprint` field never participates), and `ship-api contract` keeps reporting it on stdout and as `fingerprint` in `--format json`. `ClientContract.fingerprint` is now optional; `createHttpOperationClient` accepts a manifest with or without it and still rejects a malformed one, so already-committed contracts keep loading. Verify committed artifacts by regenerating and diffing (`ship-api contract` then `git diff --exit-code -- .ship/`); upgrade `@sixthsummit/ship-angular` alongside and regenerate once to drop the field.
