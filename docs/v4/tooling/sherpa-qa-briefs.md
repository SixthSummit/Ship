# Sherpa QA briefs

> **Optional compatibility workflow:** QA briefs may remain useful, but they are
> not part of the operation-kernel contract or a substitute for executable
> verification evidence.

Auto-generated, plain-English QA briefs from a branch's diff. Hands off to [Sherpa](https://github.com/sixthsummit/sherpa) — Sixth Summit's Claude-Code-driven QA toolkit — with **zero engineer admin work**. Editor-agnostic: Cursor and Claude Code engineers both get the same output through the CI path.

## What it solves

Engineers move fast. Writing the QA task list by hand — "here are the flows QA should test for this change" — is real admin overhead, and it gets dropped first when sprint pressure rises. The cost lands on QA: they receive code without context, or worse, code without a list at all, and have to reconstruct intent from the diff themselves.

This integration produces the same brief an engineer would have hand-written, but generates it from the diff and hands it to QA at the moment the code reaches the dev site. Engineers do nothing different. Cursor and Claude Code users are equally covered because the load-bearing trigger is in CI.

## How it works end-to-end

The lifecycle has two moments: **PR preview** and **merge handoff**.

```
┌── engineer pushes branch ───────────────┐    ┌── engineer merges to dev ─────────┐
│                                          │    │                                    │
│  PR opened against dev                   │    │  push to dev                       │
│     │                                    │    │     │                              │
│     ▼                                    │    │     ▼                              │
│  sherpa-brief.yml (PR job)               │    │  sherpa-brief.yml (push job)       │
│     │                                    │    │     │                              │
│     ▼                                    │    │     ▼                              │
│  claude -p → qa-brief agent              │    │  claude -p → qa-brief agent        │
│     │                                    │    │     │                              │
│     ▼                                    │    │     ▼                              │
│  brief.md (sticky PR comment)            │    │  brief.md (Slack + artifact)       │
│                                          │    │     │                              │
│  Engineer sees preview, can ignore       │    │     ▼                              │
│  or edit the PR description to           │    │  QA reads in Slack, pastes flows   │
│  reshape what's covered.                 │    │  into Sherpa's /explore.           │
│                                          │    │                                    │
└──────────────────────────────────────────┘    └────────────────────────────────────┘
```

**PR preview** posts (or updates) a sticky comment on the PR under a stable marker. Re-pushes update the same comment instead of piling up. The preview is informational — engineers can ignore it without consequence. Its value is letting an engineer notice "huh, the brief is missing the rate-limit sad path" before merge, when shaping the PR description is still cheap.

**Merge handoff** fires on push to `dev`. The branch deploys to the dev site (your existing deploy workflow's job, not this one); the brief lands in the QA Slack channel at roughly the same time. The QA opens Sherpa in their terminal and pastes flows one at a time into `/explore` or `/generate-test`. Sherpa walks the live app via Playwright MCP and writes specs at `projects/<name>/specs/<feature>.spec.ts`.

## What ships

Three components, layered so each is independently useful:

| Component | Path | Distribution |
|---|---|---|
| **Agent**: `qa-brief` | `packages/claude-plugin/agents/qa-brief.md` | Available in every ShipAPI repo with the plugin loaded |
| **Slash command**: `/ship:sherpa-brief` | `packages/claude-plugin/commands/ship/sherpa-brief.md` | Local preview from Claude Code |
| **Workflow**: `sherpa-brief.yml` | `packages/core/templates/default/.github/workflows/` | Shipped to new consumer apps via `ship-api create`; existing apps copy it in |

A second pair lives in the consumer template's `.claude/` so the CI run can find the agent without requiring a plugin install:

- `packages/core/templates/default/.claude/agents/qa-brief.md`
- `packages/core/templates/default/.claude/commands/sherpa-brief.md`

The plugin copy is canonical; the template copy is what CI actually invokes. If you edit the agent, edit both.

## The `qa-brief` agent

Read-only. ShipAPI-aware. Walks the diff and emits a Sherpa-paste-ready brief. Never edits source, never proposes code changes, never runs tests.

What the agent reads to enumerate surface area:

| Input | What it gives the brief |
|---|---|
| `git diff` (scoped to handlers, schemas, http/) | The blast radius — what's new, what changed, what was removed |
| PR title + body (or commit message) | The engineer's own framing of *why* this change exists |
| Route registry (MCP `list_routes` when dev server is up; static parse otherwise) | New / changed endpoints with their middleware chain |
| `requireAuth` + `requirePermission` calls | Which permission slugs gate the new flows — happy-path + permission-denied flows both get fixtures |
| `validate("json", schema)` middleware | Validation sad-paths — empty fields, too-long strings, type mismatches |
| `AppError` subclass throws (`NotFoundError`, `ConflictError`, etc.) | Domain sad-paths worth exercising |
| `defineJob`, `OutboxEventEmitter.emit`, `defineCron` | Async side effects QA can't observe in one request — surfaced under "What this brief did NOT cover" |

**Why the agent is ShipAPI-aware instead of framework-agnostic.** A generic diff walker can spot "this PR adds a POST endpoint" but can't see the middleware chain that determines who the endpoint is *for*. ShipAPI's auth/permission/validation middleware are first-class structural primitives — knowing them is the difference between "POST /api/widgets exists" and "a user with widgets:create can do X, a user without it gets a permission error, an unauthenticated request returns 401."

## The brief format

The brief is markdown with a fixed section order. Plain English throughout the "Flows to test" section — no code, no curl snippets, no route paths. The QA's bar is "I can paste this into Sherpa's `/explore`." If they have to translate from engineer-speak, the brief failed.

```markdown
# QA brief — <feature title>

> Stack: ShipAPI (backend)  |  Repo: <owner/repo>  |  Branch: <branch>  |  PR: #<n>

## What changed (engineer's summary)
1–3 lines from the PR body or commit messages

## Surface area
- New: POST /api/widgets (requires widgets:create), GET /api/widgets/:id
- Changed: PATCH /api/accounts/:id (now requires accounts:write)
- Removed: DELETE /api/legacy/foo

## Flows to test (paste these into Sherpa's /explore one at a time)
1. A signed-in user with widgets:create creates a widget named "Test" and sees it in the list.
2. A signed-in user without widgets:create tries to create one and gets a clear permission-denied message — no widget is created.
3. An unauthenticated request to the widgets page is redirected to sign-in.
4. Creating a widget with an empty name shows an inline validation error.

## Auth / permission paths touched
- widgets:create (new) — needs a fixture user with this permission
- accounts:write (existing) — re-verify after the PATCH change

## Likely sad paths worth exercising
- Replaying a request with a repeated Idempotency-Key returns the cached response.
- Sending requests above the rate limit returns 429.

## What this brief did NOT cover
- UI affordances on the consuming frontend — see the companion ShipAngular brief.
- Async job side effects — this diff enqueues `send-welcome` via the outbox; QA can't observe it in a single browser flow.
- Anything outside the diff range.
```

**Why "no code in flows."** Sherpa walks the live app via Playwright MCP. It discovers selectors itself (`getByRole`, `getByLabel`, `getByText`). If the brief writes `POST /api/widgets` into a flow, Sherpa has nothing useful to do with that string — it's not a button text. Plain user-behavior descriptions ("a signed-in user clicks Create") translate cleanly into Playwright steps; framework vocabulary does not.

## The GitHub Action

`packages/core/templates/default/.github/workflows/sherpa-brief.yml`. New consumer apps scaffolded with `ship-api create` get it for free. Existing consumer apps copy it in — see [Install in an existing app](#install-in-an-existing-app) below.

### Triggers

```yaml
on:
  pull_request:
    branches: [dev]
    types: [opened, synchronize, reopened]
  push:
    branches: [dev]
```

**PR-to-dev** posts a sticky comment under marker `<!-- sherpa-brief -->`. Concurrency is keyed by `github.ref` and cancels in progress — pushing five commits in a row doesn't run five briefs.

**Push-to-dev** is the load-bearing trigger. The brief is uploaded as a workflow artifact (`sherpa-brief-<run_id>/brief.md`) and posted to Slack via `SLACK_QA_WEBHOOK_URL`. If the webhook secret isn't set, the workflow emits a `::warning::` and skips Slack — useful for staging the workflow in a repo before flipping on the handoff.

### Slack message shape

Block Kit, three sections:

- **Header** — the brief's H1 (the feature title)
- **Fields** — stack label, repo, branch
- **Section** — first ~2,500 chars of `brief.md` inline (truncated with a "open full brief" hint if longer)
- **Actions** — buttons for "Open full brief" (artifact URL) and "View commit"

Realistic briefs fit inline; large diffs spill into the artifact link. QA can act on the inline preview alone in most cases.

### Required secrets

| Secret | Purpose | Optional? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Authenticates the headless `claude -p` run | Required |
| `SLACK_QA_WEBHOOK_URL` | Incoming Webhook for the QA channel | Optional (handoff is skipped if unset) |
| `GH_PACKAGES_TOKEN` | npm install access for `@sixthsummit/*` private packages | Required if the consumer uses private packages |

The workflow's auth path is the API key today. If your team bills Claude through a Pro subscription, swap to `CLAUDE_CODE_OAUTH_TOKEN` and pass `--api-key` differently — the change is one line in the workflow's `Run qa-brief agent` step.

### Configurable env

- `STACK_LABEL` — defaults to `'ShipAPI (backend)'`. The label appears in the Slack header so QA knows which half of the stack just shipped. ShipAngular's mirror sets it to `'ShipAngular (web)'`.
- `DEPLOY_BRANCH` — defaults to `dev`. If your consumer uses a different deploy branch (`staging`, `qa`, etc.), edit the `on:` block.

## The `/ship:sherpa-brief` slash command

Local preview for Claude Code users. Same agent, same brief, but printed to the terminal so an engineer can see what QA will get before pushing.

```
/ship:sherpa-brief
/ship:sherpa-brief --base origin/main
```

Argument-hint: `[--base <ref>]`. Defaults to the merge-base with `main`. Sets no env vars and produces no PR comment / Slack post — that's the workflow's job. **Cursor users can't run this**, but the CI path covers them.

## Cross-stack QA: ShipAPI + ShipAngular

When a feature touches both your ShipAPI backend and a [ShipAngular](https://github.com/sixthsummit/ship-angular) frontend, install the same workflow in both repos. Each emits its own brief on merge. QA receives two Slack messages with overlapping branch slugs / PR titles and correlates them mentally.

There's no coordinator service joining the two briefs. By design — coordination infrastructure for two messages a day isn't worth its operational cost. Each brief's "What this brief did NOT cover" section explicitly mentions the companion brief, normalizing the two-message expectation. QA learns the pattern in a few cycles.

The ShipAngular brief differs only in surface-area enumeration: it walks Angular routes (`app.routes.ts` + `modules/<name>/routes.ts`), `createResource()` calls (so it knows which backend endpoints the new pages exercise), component forms / validators, and auth guards. The header, the "Flows to test" section, and the section order are identical to the ShipAPI brief — same vocabulary, same paste-into-Sherpa shape.

See [`ShipAngular's docs`](https://github.com/sixthsummit/ship-angular) for the frontend half of the integration.

## Install in an existing app

New apps scaffolded via `ship-api create` get this automatically. Existing apps follow these one-time steps.

1. **Copy the workflow file:**
   ```sh
   mkdir -p .github/workflows
   cp node_modules/@sixthsummit/ship-api/templates/default/.github/workflows/sherpa-brief.yml \
      .github/workflows/sherpa-brief.yml
   ```

2. **Copy the agent + slash command into your repo's `.claude/`:**
   ```sh
   mkdir -p .claude/agents .claude/commands
   cp node_modules/@sixthsummit/ship-api/templates/default/.claude/agents/qa-brief.md .claude/agents/
   cp node_modules/@sixthsummit/ship-api/templates/default/.claude/commands/sherpa-brief.md .claude/commands/
   ```

3. **Add repo secrets** (GitHub Settings → Secrets and variables → Actions):
   - `ANTHROPIC_API_KEY`
   - `SLACK_QA_WEBHOOK_URL` (optional — handoff is skipped with a warning if unset)

4. **(Optional) Customize `STACK_LABEL`** in the workflow if your repo identifies as something other than `ShipAPI (backend)`.

5. **(Optional) Change `DEPLOY_BRANCH`** if your deploy branch isn't `dev`. Search-and-replace `dev` in the workflow's `on:` block.

## Verifying the install

1. Open a draft PR against `dev` and undraft it. Within a couple of minutes, watch for a comment posted under `<!-- sherpa-brief -->`. Push another commit; confirm the comment is *updated*, not duplicated.
2. Merge the PR. Watch the QA Slack channel for the brief. Click "Open full brief" — confirm the artifact loads.
3. Take two flows from the brief and paste them into Sherpa's `/explore` in `../sherpa`. Confirm Sherpa walks them without further engineer input.

If the Slack message never arrives but the workflow shows green, check the workflow logs for `::warning::SLACK_QA_WEBHOOK_URL not set` — that's the most common reason.

## Operational concerns

**The brief is generated, not curated.** It's only as good as what the agent can infer from the diff. PRs that bundle ten unrelated changes get briefs that look like ten unrelated lists. Atomic PRs produce sharper briefs.

**The PR preview is *informational*, not gating.** Engineers don't have to read it, edit it, or approve it. The merge-to-dev handoff fires regardless. Treating the preview as a required review step would reintroduce the admin burden this feature was built to remove.

**Briefs degrade gracefully on shallow diffs.** A diff that only touches tests, migrations, or generated files produces a short honest brief: "No observable backend behavior changes detected." The agent is instructed to write *less* before it writes *worse*.

**Slack delivery is best-effort.** The webhook can fail, the channel can be archived, Block Kit can render odd in a thread. The workflow artifact is the durable record; treat the Slack message as the notification, not the source of truth.

**The agent runs headless in CI.** It can't ask clarifying questions. If you want the brief to reflect "the engineer's framing of *why*", put that framing in the PR description. The agent reads `PR_BODY` and uses it for the "What changed" section.

## Why this lives in the plugin

The agent's value comes from being ShipAPI-aware. A framework-agnostic diff walker can be useful, but it can't enumerate auth chains, permission slugs, validation surfaces, or AppError sad-paths — the structural primitives that determine what QA should test. Bundling the agent with the plugin keeps the brief quality high and ties its evolution to the framework's conventions: when the middleware surface changes (a new `idempotency` middleware lands, say), the agent's enumeration updates in the same release.

## Why the workflow lives in the template, not the framework

Consumer apps deploy. Framework repos don't. The workflow's trigger (`push: branches: [dev]`) only makes sense on a repo that has a `dev` deploy branch — which is a consumer-app concept. Shipping it in the template means `ship-api create my-app` produces an app with the QA handoff already wired; an engineer creating a new app gets the feature for free, no extra steps.

The framework repo itself doesn't run this workflow — there's no `dev` deploy branch on `@sixthsummit/ship-api`, and the framework's tests don't depend on user-visible app behavior. CI on the framework is `type-check` + `lint` + `test` + `build` + `check:skills`, and that's what stays.

## Source

- [`packages/claude-plugin/agents/qa-brief.md`](https://github.com/sixthsummit/ship-api/blob/main/packages/claude-plugin/agents/qa-brief.md) — agent source
- [`packages/claude-plugin/commands/ship/sherpa-brief.md`](https://github.com/sixthsummit/ship-api/blob/main/packages/claude-plugin/commands/ship/sherpa-brief.md) — slash command
- [`packages/core/templates/default/.github/workflows/sherpa-brief.yml`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/templates/default/.github/workflows/sherpa-brief.yml) — workflow
- [`packages/claude-plugin/docs/sherpa-brief.md`](https://github.com/sixthsummit/ship-api/blob/main/packages/claude-plugin/docs/sherpa-brief.md) — install reference for existing apps
- [tooling/claude-plugin](claude-plugin.md) — the plugin overall
- [Sherpa](https://github.com/sixthsummit/sherpa) — the QA toolkit the briefs feed
