---
description: Run vitest in watch mode against the core package
allowed-tools: Bash(pnpm:*)
argument-hint: '[optional pattern]'
---

# /ship:run-vitest

Run Vitest against the ShipAngular core package. Defaults to watch mode so the user can iterate; takes an optional pattern argument that's forwarded as a test name filter.

## Steps

1. If `$ARGUMENTS` is empty, run `pnpm --filter @sixthsummit/ship-angular test:watch` in the foreground.
2. If `$ARGUMENTS` is non-empty, run `pnpm --filter @sixthsummit/ship-angular test:watch -- --testNamePattern="$ARGUMENTS"`.
3. Stream output. The user expects watch UI; do not buffer or filter.

## Notes for Claude

- Use the `Bash` tool with `run_in_background: true` for watch mode so the session isn't blocked. Tail output with `BashOutput` if you need to inspect it later.
- If vitest reports failures, do not silently kill the watcher — let the user see the failure and decide whether to fix or abort.
- For one-shot runs (CI-style), the user should use `pnpm test` directly; this command is specifically for the watch UX.
