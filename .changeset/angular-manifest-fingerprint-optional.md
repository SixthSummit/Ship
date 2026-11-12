---
"@sixthsummit/ship-angular": patch
---

Accept ShipAPI client manifests that carry no `fingerprint`. `@sixthsummit/ship-contract` 1.6 stops storing the contract's digest in `.ship/contract.json` so regenerated contracts merge cleanly; `ShipApiClientContractManifest` and `ShipStreamManifest` now list `fingerprint` as optional, and `createShipApiClientExecutor` and `resolveShipStreamOperation` accept the field when present (a malformed one is still rejected) and no longer require it.
