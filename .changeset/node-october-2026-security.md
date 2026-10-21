---
"@sixthsummit/ship-api": patch
"@sixthsummit/ship-hono": patch
"@sixthsummit/ship-cache-redis": patch
"@sixthsummit/ship-testing": patch
---

Require the October 2026 Node.js security releases (22.23.4, 24.22.1, 26.12.1 or newer),
which fix the Brotli decoder remote code execution (CVE-2026-111497), TLS hostname
verification bypasses, and `dns.resolve` truncation. Bump `hono` to 4.13.13 to pick up
the `serveStatic` double-decode middleware bypass fix (GHSA-5r4p-p66f-jhc7).
