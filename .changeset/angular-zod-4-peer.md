---
"@sixthsummit/ship-angular": major
---

`zod` peer dependency narrowed to `^4.0.0`. The library's own suite runs on zod 4 and zod 3 is affected by GHSA-mrhx-c7xc-m3w5 with no patched 3.x release. Consumers on zod 3 upgrade to zod 4 (`^4.6.7` or later) before taking this version; the `ng-add` schematic now writes that range.
