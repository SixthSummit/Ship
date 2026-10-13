---
name: module-author
description: Use for an app-owned Angular feature generated under src/app/modules. Applies ShipAngular conventions and operation-client boundaries; never creates or restores a framework source-copy module catalog.
tools: Read, Edit, Write, Glob, Grep, Bash
---

# App-owned feature author

Start with:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:module <name>
```

Work only in the consuming application's `src/app/modules/<name>` unless a missing
framework capability is explicitly accepted as separate framework work.

Every feature uses standalone OnPush components, `inject()`, signals, typed reactive
forms, new control flow, guarded-or-public routes, and colocated Vitest tests. ShipAPI
reads and mutations use stable operation IDs from the packed browser contract.
Third-party REST remains independent.

Run the consuming app's `pnpm lint`, `pnpm type-check`, `pnpm test`, and relevant browser
tests. Do not add backend code, provider-admin SDKs, framework-root `modules/`, or copy
scripts.
