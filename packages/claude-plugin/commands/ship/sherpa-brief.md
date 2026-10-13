---
description: Generate a Sherpa-ready QA brief from the current branch's backend diff. Plain-English flows the QA pastes into Sherpa's /explore. Engineer admin work goes to zero.
argument-hint: "[--base <ref>]"
allowed-tools: Bash, Agent
---

Run **qa-brief** against the current branch's diff.

**Base ref resolution** (in order):

1. `$1` if present and parseable as `--base <ref>`
2. `BASE_REF` env var if set (the GitHub Action sets this)
3. Default: the merge-base with `main` (`git merge-base main HEAD`)

**Head ref:** `HEAD_REF` env var if set, otherwise `HEAD`.

**PR context** (optional, set by the workflow when available):

- `PR_TITLE`, `PR_BODY`, `PR_NUMBER`, `REPO`, `BRANCH` env vars feed the brief's header

Scope the diff to files that affect observable backend behavior. The agent will compute the diff itself; just pass the resolved base + head refs in the prompt.

Invoke the **qa-brief** subagent. Surface its markdown output as the response — do not summarize, do not editorialize.

If `--base` was passed but doesn't resolve to a valid ref, fall back to the default and note the fallback in a one-line prefix above the brief.
