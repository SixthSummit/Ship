# Sherpa QA brief workflow

Auto-generates a plain-English QA brief from your branch's diff and hands it
off to the QA team in Sherpa. Zero engineer admin work — Cursor and Claude
Code users both get the same output through the CI path.

## What ships

1. **`qa-brief` agent** (in `packages/claude-plugin/agents/`) — walks the diff
   and emits a Sherpa-paste-ready brief. ShipAPI-aware: enumerates routes,
   auth/permission chains, validation, and AppError-driven sad paths.
2. **`/ship:sherpa-brief` slash command** — local preview. Run on your branch
   to see what QA will get before you push.
3. **`sherpa-brief.yml` workflow** (in `packages/core/templates/default/.github/workflows/`) —
   the editor-agnostic trigger. Fires on:
   - PR to `dev` → posts a sticky preview comment on the PR.
   - Push to `dev` → posts the final brief to the QA Slack channel and uploads
     `brief.md` as a workflow artifact.

## Install in an existing consumer app

New apps scaffolded via `ship-api create` get this automatically. Existing
apps follow these steps once.

1. **Copy the workflow file:**
   ```sh
   cp node_modules/@sixthsummit/ship-api/templates/default/.github/workflows/sherpa-brief.yml \
      .github/workflows/sherpa-brief.yml
   ```

2. **Copy the agent + slash command into your repo's `.claude/`** so the
   workflow's headless Claude run can discover them:
   ```sh
   mkdir -p .claude/agents .claude/commands
   cp node_modules/@sixthsummit/ship-api/templates/default/.claude/agents/qa-brief.md .claude/agents/
   cp node_modules/@sixthsummit/ship-api/templates/default/.claude/commands/sherpa-brief.md .claude/commands/
   ```

3. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `ANTHROPIC_API_KEY` — used by the headless `claude -p` run.
   - `SLACK_QA_WEBHOOK_URL` — Incoming Webhook for the QA channel. The push-
     to-`dev` step skips Slack delivery (with a workflow warning) if unset, so
     this is optional until you're ready to flip on the handoff.

4. **(Optional) Customize the stack label.** The workflow's `STACK_LABEL` env
   defaults to `ShipAPI (backend)`. Edit the workflow if you want a different
   identifier in the Slack header.

5. **Confirm `dev` is your deploy branch.** The workflow keys off the `dev`
   branch (PR-to-dev preview, push-to-dev handoff). If your deploy branch is
   named differently, search-and-replace `dev` in the `on:` block.

## Verify the install

1. Open a PR against `dev` from a feature branch. Within a couple of minutes
   you should see a comment posted under the marker `<!-- sherpa-brief -->`
   with the QA brief. Pushing more commits updates the same comment.
2. After merging that PR, watch your QA Slack channel — the workflow posts
   the final brief with an "Open full brief" link to the artifact.

## How it's consumed by Sherpa

The brief's "Flows to test" section is intentionally framework-agnostic plain
English. The QA opens [Sherpa](../../../../sherpa) and pastes flows one at a
time into `/explore` or `/generate-test`. Sherpa walks the live app via
Playwright MCP and writes specs. No selectors, no test code in the brief —
that's Sherpa's job.

## Companion: frontend brief

If a feature touches both your ShipAPI backend and a ShipAngular frontend
repo, install the same workflow in both. The QA receives two Slack messages
(one per stack) with overlapping branch slugs / PR titles and correlates
them mentally. There is no coordinator service — that's by design.
