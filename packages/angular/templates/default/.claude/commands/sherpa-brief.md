---
description: Generate a Sherpa-ready QA brief from the current branch's frontend diff. Plain-English flows the QA pastes into Sherpa's /explore. Engineer admin work goes to zero.
argument-hint: '[--base <ref>]'
allowed-tools: Bash, Agent
---

# /ship:sherpa-brief

Generate a QA brief for the current branch — same brief the `sherpa-brief.yml` workflow emits, previewed locally before push.

## Base ref resolution (in order)

1. `$ARGUMENTS` if it parses as `--base <ref>`
2. `BASE_REF` env var (set by the GitHub Action)
3. Default: merge-base with `main` (`git merge-base main HEAD`)

## Head ref

`HEAD_REF` env var if set, otherwise `HEAD`.

## PR context (optional)

`PR_TITLE`, `PR_BODY`, `PR_NUMBER`, `REPO`, `BRANCH` env vars flow into the brief's header when set by the workflow. Locally, they're typically unset — the brief still works, just without PR-specific framing.

## Steps

1. Resolve the base + head refs as above.
2. Invoke the **qa-brief** subagent with those refs. Surface its markdown output as the response — do not summarize, do not editorialize.
3. If `--base` was passed but doesn't resolve to a valid ref, fall back to the default and note the fallback in a one-line prefix above the brief.

## Notes for Claude

- This is a preview command. No persistence, no Slack, no PR comment — that's the workflow's job.
- The brief is intentionally framework-agnostic in shape: ShipAPI emits the same structure on the backend half, so the QA reads them uniformly.
