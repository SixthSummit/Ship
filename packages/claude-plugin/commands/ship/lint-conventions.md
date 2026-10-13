---
description: Run ship-reviewer over the current branch's changes and surface convention violations against ShipAPI v4 patterns.
argument-hint: "[--diff | --all]"
allowed-tools: Bash, Agent
---

Run **ship-reviewer** against $1 (default `--diff`):

- `--diff` (default): review files changed in the current branch vs `main`. Use `git diff --name-only main..HEAD -- 'modules/**/*.ts' 'packages/core/src/**/*.ts'` to scope.
- `--all`: review every TS file under `modules/` and `packages/core/src/`. Slower; use before a major release.

Scope-out boilerplate the reviewer doesn't care about:

- `*.test.ts` (tests aren't held to the same convention bar)
- `lib/` and `dist/` (build output)
- `node_modules/` (never)

Pass the file list to the **ship-reviewer** subagent. Surface its findings as the response.
