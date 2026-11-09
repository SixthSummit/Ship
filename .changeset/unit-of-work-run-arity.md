---
"@sixthsummit/ship-core": patch
---

The executor calls a unit of work's `run` with two arguments when the operation keeps the default isolation level, instead of passing an explicit `undefined` third argument. A unit of work written or test-doubled against the two-argument form sees exactly the call it did before the isolation option existed.
