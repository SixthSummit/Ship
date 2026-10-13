---
description: Scaffold a new page under src/app/modules/<module>/pages/<name>/ via the framework's ng-generate schematic.
allowed-tools: Bash(pnpm:*)
argument-hint: '<module> <name>'
---

# /ship:add-page

Scaffold a new standalone, OnPush, signal-first page component under
`src/app/modules/<module>/pages/<name>/`. The framework's
`@sixthsummit/ship-angular:page` schematic does the heavy lifting:

- Creates the component file with framework conventions baked in.
- Adds the route entry to `src/app/modules/<module>/routes.ts`.
- Refuses gracefully if the target module doesn't exist.

## Steps

1. Parse `$ARGUMENTS` — first token is the module name, second is the
   page name (kebab-case for both).
2. Run `pnpm exec ng generate @sixthsummit/ship-angular:page <module> <name>`.
3. Stream output. If the schematic refuses (module missing), surface a
   helpful next step (`Run /ship:add-module <module>` first).
4. After success, run `pnpm lint` to confirm the new file passes the
   ShipAngular ESLint custom rules.

## Notes for Claude

- Use `Bash(pnpm:*)` only. Don't fall back to handwriting the page —
  the schematic ensures the file matches framework conventions.
- For `--guarded` pages, the user can append `--guarded` to the
  command; pass it through verbatim.
