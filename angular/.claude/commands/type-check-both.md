---
description: Type-check the root workspace and the template scaffold
allowed-tools: Bash(pnpm:*), Bash(node:*)
---

# /ship:type-check-both

Run `tsc --noEmit` for both surfaces that need to type-check cleanly:

1. The published library (`../packages/angular`).
2. The template scaffold (`../packages/angular/templates/default`) — because it's shipped to every new project and breaking it means breaking every consumer.

## Steps

1. Run `pnpm type-check` from the repo root (delegates to `../packages/angular`'s `tsc --noEmit`). Capture exit status.
2. Run a type-check against the template by:
   - `cd ../packages/angular/templates/default`
   - If `node_modules` doesn't exist, skip with a warning ("Template needs `pnpm install` to type-check; run from inside the template dir").
   - Otherwise: `pnpm exec tsc --noEmit -p tsconfig.app.json`. Capture exit status.
3. Report both results. If either failed, surface the errors.

## Notes for Claude

- Run both checks in parallel (single message, two `Bash` tool calls) to save time.
- The template's type-check is not part of the workspace's `pnpm type-check` — that's the gap this command fills.
- If both pass, a one-line "Both type-checks green ✓" is enough.
