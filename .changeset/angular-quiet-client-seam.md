---
'@sixthsummit/ship-angular': patch
---

Use ShipAPI's canonical client type for the `/ship-api` adapter to keep large generated contracts type-checkable, and reject stream handles at the unary executor boundary.
