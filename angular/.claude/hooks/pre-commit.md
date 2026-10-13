---
event: PreToolUse
matcher: 'Bash'
description: Pre-commit guard — when about to run `git commit`, ensure the framework's CI passes locally before the commit lands.
---

# Pre-commit hook

When the assistant is about to run `git commit ...`, this hook intercepts
and runs `pnpm pre-commit` first. If pre-commit fails, the commit is
blocked and the assistant must fix the underlying issue before retrying.

## Behavior

- Triggers on `Bash` invocations whose command starts with `git commit`.
- Runs `pnpm pre-commit` (`sync-version → type-check → lint →
format:check → test`).
- On failure, returns a non-zero exit so Claude Code blocks the commit.
- On success, proceeds with the original commit.

## Bypass

Don't `--no-verify` the underlying git command to skip — fix the failure.
The framework's conventions are the contract; bypassing means shipping
broken code. If the failure is a flaky test, fix the test, not the hook.
