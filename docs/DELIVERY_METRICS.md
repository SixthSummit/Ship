# Delivery Measurement Playbook

> **Audience**: whoever owns ShipAPI adoption across the project portfolio.
> **Status**: forward-looking. Introduce incrementally as ShipAPI rolls out into real projects — most of this is meaningless at one project and becomes meaningful as the portfolio grows.
> **Companions**: [`V4_LAUNCH.md`](V4_LAUNCH.md) (the pitch), [`V4_STATUS.md`](V4_STATUS.md) (framework execution). This doc tracks the *effect on delivery*, not the framework's internals.
> **Created**: 2026-05-30.

## Why this exists

The bet behind ShipAPI + ShipAngular is **delivery standardization**: one consistent stack across every client project, so engineers move between projects without re-learning the plumbing, projects start fast, and a fix made once protects all of them. That bet only pays if delivery actually gets **faster, more consistent, and more reliable** than the pre-ShipAPI baseline. If it doesn't, the framework is a cost center wearing a leverage costume.

So we measure the framework the way you measure **infrastructure** — by its effect on deliveries — not the way you measure a **product** — by its feature completeness. Coverage %, feature count, and GA-readiness are deliberately *not* on this scoreboard. What's on it is: how long a module takes, how fast a new engineer ramps, how many defects escape to prod, and whether "one stack" is still true.

Two structural advantages make this cheap for us, and the whole playbook leans on them:

1. **The portfolio is a natural experiment.** Comparable projects on the same stack — project #2 vs project #7 — let us watch trends without a control group.
2. **The stack already emits the artifacts.** Conventional Commits + Changesets, CI runs, OpenTelemetry traces, the route registry. We derive metrics from what we already produce instead of standing up a measurement apparatus.

And one honest caveat, stated once and assumed throughout: with a handful of projects and a handful of engineers, this is **directional instrumentation plus a disciplined retro — not a controlled experiment**. The numbers are noisy and gameable. Treat them as smoke detectors, not a dashboard to optimize.

## Operating principles

1. **Derive, don't instrument.** If a metric can't be computed from git / CI / OTel artifacts we already produce (plus one short retro), it's probably not worth collecting yet.
2. **The portfolio is the experiment.** Single-project numbers are anecdotes. Trends *across* projects are the signal.
3. **Directional, not scientific.** Small-n and gameable. Use for "is this getting better or worse," never for precise claims or individual performance.
4. **Measure delivery effects, not framework internals.** No framework-internal stat belongs on this scoreboard.
5. **Pull, not push.** The retro feeds the framework backlog. A feature earns its way into ShipAPI by recurring as a workaround across projects — not because it's satisfying to build.

## What we measure

Each metric below lists the question it answers, the precise unit, where the data comes from, whether it's automatable, what "good" looks like, and the honest caveat.

### Tier 1 — the standardization thesis itself

These two are specific to our situation; most shops can't compute them. They directly measure whether the bet is paying off, so they matter most.

**M1 — Version skew across the portfolio**
- *Answers*: Is "one consistent stack" actually true, or are projects quietly forking in place?
- *Unit*: distribution of the `@sixthsummit/ship-api` version across all live projects; **median lag (in days) behind latest published**.
- *Source*: each project's lockfile + the package's published release dates. Fully automatable (see T1).
- *Good*: a tight cluster within one minor of latest; median lag flat or trending down. A **widening spread is the alarm** — standardization decaying into N de-facto forks no matter how clean any single project looks.
- *Caveat*: a deliberately pinned legacy project is fine. What you're watching is *unintended* drift — annotate intentional pins so they don't pollute the signal.

**M2 — Framework-fix multiplier**
- *Answers*: How much leverage is the shared core actually buying? (The upside of the concentration risk standardization creates.)
- *Unit*: for each `fix:` landed **in ShipAPI**, the count of projects on (or that will adopt) that version. Reported as "1 fix → N projects protected," summed per release.
- *Source*: framework `fix:` commits (Conventional Commits) × M1's version census.
- *Good*: a rising multiplier over time — each framework fix protects more projects. This is the number that justifies the whole frame.
- *Caveat*: only counts if projects actually *adopt* the fix — M2 is hollow if M1 shows wide skew. The two are read together.

### Velocity

**M3 — Time to add the Nth module**
- *Answers*: Is building a standard unit of work getting cheaper and more predictable across projects?
- *Unit*: elapsed working-time from the `ship-api g {module|resource}` scaffold commit to the "module done + tested + merged" commit. Compared **at the same N across projects** (e.g. every project's 5th module) — a repeatable unit, unlike one-shot time-to-first-endpoint, which is confounded by setup, credentials, and client delays.
- *Source*: the `scaffold.at` field stamped into each module's `module.json` (exact start-point — see "Make the framework emit the breadcrumbs") through to the module's done/merge commit in git.
- *Good*: cost roughly **flat across projects** and trending down. If it isn't flat, the conventions aren't actually shared — that's a finding.
- *Caveat*: elapsed wall-clock ≠ effort (an engineer juggles things). Use medians, drop outliers, and **exclude the first one or two ShipAPI projects** — those measure the team's learning curve, not the framework.

### Developer mobility

**M4 — Ramp to steady state on an unfamiliar project**
- *Answers*: Can an engineer who knows one ShipAPI project be productive on another in days, not weeks? (The heart of the thesis.)
- *Unit*: time from an engineer's first commit on a repo they've never touched to the point their merged-PR throughput matches their personal steady state. The claim under test: ramp on **plumbing** (auth, CRUD, jobs, deploy) → near zero; ramp on **domain** is irreducible.
- *Source*: git author history across repos (aggregate), corroborating the retro. **The retro question is the primary signal; the git curve corroborates.**
- *Good*: across successive projects, the retro answer to "what did your first week fight" drifts from *framework/tooling* toward *domain*.
- *Caveat*: **aggregate and diagnostic only.** Per-engineer git metrics must never become individual performance ranking or surveillance — that poisons retro honesty and the whole program. See Anti-patterns.

### Quality

**M5 — Escaped defects by layer**
- *Answers*: Are bugs concentrating where they should (domain logic), and is the shared plumbing trending toward zero defects?
- *Unit*: defects that reach **production** (not those caught in review/CI), severity-weighted, plus MTTR. Bucketed by layer: framework/plumbing-shaped code (`modules/*/routes.ts`, auth, validation, jobs, data access) vs. domain code.
- *Source*: OTel/Sentry error rates + `fix:` / `revert:` commits classified by touched path.
- *Good*: plumbing-layer escaped defects trend toward zero across the portfolio as the shared core hardens; remaining defects sit in domain code ("just software").
- *Caveat*: raw counts are gameable and reporting-dependent — watch *escaped* defects and MTTR, severity-weighted, not totals. A plumbing-layer bug is also a framework signal (candidate fix + M2 multiplier).

### Agent parity

**M6 — Agent output-parity (Claude Code vs Cursor)**
- *Answers*: Do both supported agent tools deliver the *same* result on the same task, or is one quietly a second-class path? (v4 set out to close the Cursor-vs-Claude two-tiering; this watches that it stays closed.)
- *Unit*: two reads, together — (a) the **G4 agent-parity rubric** total on a fixed module-generation task, scored once per tool (see [`AGENT_PARITY_RUBRIC.md`](AGENT_PARITY_RUBRIC.md)); and (b) the **by-tool split of M3** (time-to-Nth-module), bucketed on the `scaffold.tool` breadcrumb.
- *Source*: the rubric scorecard (manual, quarterly) + `scaffold.tool` in each module's `module.json` × M3's start/end commits.
- *Good*: the two tools' rubric totals stay within one band of each other, neither tool's by-tool M3 is systematically slower, and the retro's "which agent did you fight" answer doesn't cluster on one tool. **A widening gap is the alarm** — input parity (synced rules, guarded by `check:skills`) was the easy half; this watches that *output* parity holds.
- *Caveat*: rubric scoring is judgment — fix the task, score both runs back-to-back, one rater, to cancel drift. By-tool M3 is small-n and confounded by *who* drove which tool (a senior on Cursor vs a junior on Claude isn't a tool comparison); read it as directional, never "tool X is better," and aggregate only — never per-engineer.

## The ritual: per-project retro

The human core of the program, and at our scale **higher signal than any chart**. Run it at each project's close (or per milestone on long projects). Keep it to three fixed questions so answers are comparable over time:

1. **Where did the time actually go?** (Which phases/areas ate the calendar.)
2. **What did your first week fight — the framework/tooling, or the client's domain — and did it differ by agent tool (Claude Code vs Cursor)?** (Feeds M4 + M6.)
3. **What did you copy-paste, work around, or wish existed?** (Feeds the framework backlog — this is the pull-not-push generator.)

- *Owner*: the adoption lead (one person accountable for collecting and rolling up).
- *Storage*: append answers to a running log (same place as this doc, or a tracker) so trends are visible across projects.
- *Output*: question 3's recurring items become candidate framework work — a workaround that shows up on three projects has earned its way into ShipAPI.
- *Tool tag*: record which agent tool(s) built the project's modules (`scaffold.tool` stamps it per-module automatically); it lets question 2's "what did you fight" be split Claude-vs-Cursor — the qualitative half of M6.

## Make the framework emit the breadcrumbs

Several metrics get dramatically cheaper — and more precise — if ShipAPI itself records the measurement breadcrumbs. These are small, on-theme enhancements (the stack is introspectable by design; lean into it), and they're **pull-not-push in action**: the measurement need pulls a tiny CLI feature. Worth doing *before* rollout, because some can't be reconstructed after the fact.

- ✅ **Implemented** — `ship-api g module` / `g resource` stamp a `scaffold` block into the generated `module.json`: `{ generator, name, at (ISO timestamp), frameworkVersion, tool }`. This is M3's exact, un-backfillable start-point — it records *when* a module was generated, under which framework version, and **by which agent tool** (`tool`: `claude-code` / `cursor` / `cli` — Claude Code auto-detects via its `CLAUDECODE` flag; Cursor has no reliable env marker, so Cursor users set `SHIP_API_SCAFFOLD_TOOL=cursor`, else the run falls through to `cli`). It rides into git with the module and needs no commit-message discipline; the `tool` field is what lets M3 split by tool and feeds M6's parity read. (Originally sketched as a commit trailer; a manifest field is strictly better — the start-point survives rebases/squashes and is readable at any commit.)
- **Tag the framework version in each project's CI run** (or a `/dev/version` style endpoint reading the installed package version) so M1's census can be scraped from a known place rather than parsing lockfiles.
- **Layer-label convention in commit scope** — lean on the existing Conventional Commit scope (`fix(auth):`, `fix(<module>):`) so M5's layer bucketing is a scope-grep, not a path heuristic.

## Rollout plan

Phased by **how many projects are live**, because comparison is the engine and you can't compare what you don't have yet. The throughline: instrument early even when you can't yet analyze — you're banking data and setting conventions so the signal is there when the portfolio grows.

### Phase 0 — First project (now → project #1 in production)
No cross-project comparison is possible yet. The work is setup, and the point is **not to wait**:
- Reconstruct a **baseline from legacy / pre-ShipAPI projects'** git history (approximate time-to-module, defect patterns) so you have a credible "before."
- ✅ The **scaffold breadcrumb** is implemented — the `g` commands stamp `module.json`. No action beyond keeping the `scaffold` field intact in generated modules (don't strip it in review).
- Stand up the **version-skew script** (trivial at n=1) and the **commit-analysis script** so they're ready, not blocking.
- **Start the retro from project #1** even though n=1 — you're banking qualitative data and establishing the ritual.
- *Informs*: almost nothing yet. This phase is pure instrumentation.

### Phase 1 — 2–4 projects
First real comparisons appear:
- **M1 version skew** goes live and weekly (auto-posted).
- First **M3** comparisons — is project #3's 5th module cheaper than project #1's?
- First **M4** read if any engineer has moved between projects.
- Retro question 3 starts surfacing **recurring** workarounds → first framework-backlog candidates.
- *Informs*: Are the conventions actually shared (is module cost flat)? Is the framework backlog being fed by real pain?

### Phase 2 — 5+ projects, steady cadence
Trends become trustworthy:
- **M2 framework-fix multiplier** becomes a meaningful, motivating number.
- **M5 escaped-defects-by-layer** trend across the portfolio is readable.
- Consider a **lightweight dashboard only now**, and only if the manual rollup is genuinely eating time — not before.
- *Informs*: Where to invest framework effort (which layer still generates defects/workarounds), and the headline question — **is standardization ROI real?** (module cost flat-and-falling, ramp shrinking, plumbing defects → 0, version skew tight).

## Tooling specs

Specs, not code — build when the corresponding phase arrives. Both rely on conventions we already enforce (Conventional Commits, Changesets) plus the optional breadcrumbs above.

**T1 — Portfolio version-skew checker** (Phase 0/1)
- *Input*: a list of project repo paths or package registry coordinates.
- *Method*: read `@sixthsummit/ship-api` from each lockfile; fetch published release dates; compute the version histogram + median lag behind latest.
- *Output*: a short report — histogram, median lag in days, list of projects >1 minor behind (with intentional-pin annotations honored). Post weekly to Slack.
- *Runs*: scheduled job, or a `ship-api` CLI subcommand pointed at a project manifest.

**T2 — Commit-based velocity + defect breakdown** (Phase 0/1)
- *Input*: a repo (or set of repos).
- *Method*: read each module's `module.json` `scaffold.at` (M3 start, exact) → its done/merge commit (M3 end), and `scaffold.tool` (the by-tool split for M6); classify `fix:`/`revert:` commits by Conventional Commit scope/path into plumbing vs domain (M5); summarize per project and per N-th module.
- *Output*: per-project median time-to-Nth-module (and the same split by `scaffold.tool` for M6); defect counts by layer over time. The start-point is exact (`scaffold.at`); module-*done* detection remains a merge-commit heuristic, and the by-tool split is confounded by *who* drove which tool — emit it as directional per M6, never as a tool-vs-tool verdict.
- *Runs*: ad hoc / monthly rollup. Aggregate only; never emit per-engineer leaderboards.

## Anti-patterns

- **Premature dashboard.** Don't build one before Phase 2. At low n the retro outperforms any chart, and a dashboard creates pressure to optimize noise.
- **Optimizing the gameable metric.** These are smoke detectors. The moment a number becomes a target someone is judged on, it stops measuring reality.
- **Weaponizing per-engineer data.** M4 and the commit analysis are **diagnostic of the framework and onboarding, in aggregate**. Used as individual performance ranking, they destroy retro honesty and corrupt the whole program. This is a hard line.
- **Measuring framework internals.** Coverage %, feature count, GA checklist — off this scoreboard. They answer "is the framework done," not "is delivery better."
- **Trusting small-n as truth.** Two projects is a story, not statistics. Report trends and ranges; resist precise claims.

## Open decisions (settle before Phase 1)

- Where the rolled-up metrics and retro log live, and who has the standing weekly view.
- Who owns the adoption-lead role (one accountable person).
- The severity-weighting scheme for M5 (e.g. auth bypass ≫ cosmetic).
- The operational definition of "steady state" for M4 (e.g. trailing-4-week median merged-PR rate).
- _(Resolved)_ The scaffold breadcrumb is implemented. Remaining breadcrumb ideas — CI framework-version tag (M1) and commit-scope layer labels (M5) — are optional and can land when the corresponding script does.
