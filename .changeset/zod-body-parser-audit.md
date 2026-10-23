---
"@sixthsummit/ship-angular": patch
"@sixthsummit/ship-auth-credentials": patch
"@sixthsummit/ship-cli": patch
"@sixthsummit/ship-console": patch
"@sixthsummit/ship-contract": patch
"@sixthsummit/ship-api": patch
"@sixthsummit/ship-drizzle": patch
"@sixthsummit/ship-hono": patch
"@sixthsummit/ship-jobs-bullmq": patch
"@sixthsummit/ship-core": patch
"@sixthsummit/ship-mail": patch
"@sixthsummit/ship-api-mcp-server": patch
"@sixthsummit/ship-realtime-socketio": patch
"@sixthsummit/ship-storage": patch
"@sixthsummit/ship-testing": patch
---

Require `zod` `^4.6.7` (GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections) and resolve `body-parser` to `2.4.0` under the MCP server's Express dependency (GHSA-27r3-jxmh-p828). No API change; the Angular library now runs its own suite against zod 4 and the Angular scaffold template asks for `zod ^4.6.7`.
