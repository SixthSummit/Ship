# Agent Parity Rubric (G4)

> **Audience**: whoever owns ShipAPI's agent tooling. Companion to [`V4_STATUS.md`](V4_STATUS.md) (G4) and [`DELIVERY_METRICS.md`](DELIVERY_METRICS.md) (M6).
> **Status**: the written form of G4's "manual quarterly verification" — run a real agent session, score whether it produced a working module, and do it *identically* for each supported tool so the two are comparable.

## Why this exists

v4 set out to close the **Cursor-vs-Claude two-tiering**: both tools consume the same synced `.cursor/rules/` ↔ SKILL.md conventions, the same MCP server (`list_routes` / `describe_route` / `execute_route`), the same generators. **Input parity is proven** — the `check:skills` guard fails CI if the rule sources drift from the plugin skills. **Output parity — do both tools actually deliver an equally good module from the same prompt? — is not.** This rubric is the repeatable check, and the G4 line in `V4_STATUS.md` points at it.

It is deliberately a **manual, low-frequency** eval (quarterly): an LLM-driven agent flow can't be asserted in CI without spawning the agent itself, so the structural plugin/MCP smoke tests (G4 part a/b) cover the wiring and this covers the flip side — *given a prompt, does a working module come out*.

## The fixed task

Score every run on the **same task**, so tool-vs-tool and quarter-vs-quarter stay comparable. Changing the task resets the baseline — only do it deliberately, and re-run all tools when you do.

> **Canonical task.** In a fresh `ship-api create` app, **using only the agent** (no manual edits, no copy-paste from another module), add a `billing` module: an `invoices` resource with fields `{ amount:integer, currency:string, status:string, dueAt:timestamp?, accountId:uuid }` (illustrative — the agent may hand-write the schema), full CRUD behind `requireAuth` + `requirePermission`, Zod validation, a `DrizzleEntityService`, service + route tests, and a generated migration. Then add a domain method `markPaid(id)` and a route that calls it.

Run it **once per tool** (Claude Code, Cursor), same prompt, same starting commit, by the **same person back-to-back** — that cancels rater drift and rough-day noise. Record the `scaffold.tool` value the run stamps into `module.json` (it should match the tool you drove).

## The scorecard

Score each dimension **0 / 1 / 2** (fail / partial / pass). The criteria are objective on purpose — they map to commands and to the conventions the `ship-reviewer` agent already enforces, so two scorers land in the same place.

| Dimension | 0 (fail) | 1 (partial) | 2 (pass) |
| --- | --- | --- | --- |
| **Compiles** | `npm run type-check` fails | passes after a manual fix | `npm run type-check` clean as produced |
| **Tests** | no tests, or `npm test` red | tests present but thin / one red | service **and** route tests, `npm test` green |
| **Conventions** | multiple breaks | one minor break | `npm run lint` clean (lint catches raw `c.req` + raw Drizzle/QueryOptions, A2-7) **and** a manual read confirms the rest: `validate()` used, `requireAuth` + `requirePermission` on **every** protected route, AppError taxonomy not inline JSON, `drizzle-kit` migration not hand-SQL |
| **Canonical shape** | files missing | most of the 7-file shape | all 7 files (schema/permissions/validation/service/routes/index/module.json) + a generated migration; routes **return the chained app** (hc() types survive) |
| **End-to-end** | route 500s or wrong shape | happy path only | `execute_route` works: auth rejection, permission rejection, validation rejection, the CRUD happy path, and the `markPaid` route all behave |
| **Autonomy** | needed heavy hand-holding / a human wrote the hard part | several corrective turns | ≤ 2 corrective turns from prompt to green |

*A **corrective turn** (Autonomy row) = a human-authored message that points out a specific defect or redirects the agent. It excludes the initial prompt, the agent answering its own clarifying question, and the agent self-correcting after running type-check / lint / test on its own initiative.*

**Total: / 12.** Band it: **10–12** parity-grade, **7–9** usable-with-edits, **≤ 6** the tool is a second-class path on this task — a finding.

## The delta read

Record both tools' totals **and** the per-dimension scores — the signal is the **gap**, not the absolute. A 11-vs-10 is parity; a 11-vs-6, or the same dimension scoring 0 on one tool every quarter, is the two-tiering re-opening.

```
Quarter: 2026-Qn   Task: billing/invoices vN   Scorer: <name>
                         Claude Code   Cursor   Δ
  Compiles                   2           2       0
  Tests                      2           1      -1
  Conventions                2           2       0
  Canonical shape            2           2       0
  End-to-end                 2           1      -1
  Autonomy                   2           1      -1
  TOTAL                     12           9      -3
  Notes: Cursor needed a nudge to add the route test + to use QueryOptions
         instead of a raw `eq()` in markPaid (A2-7 caught it at lint).
```

## How it connects

- **G4** (`V4_STATUS.md`): this rubric *is* G4's "manual quarterly verification," now written down instead of folklore.
- **M6** (`DELIVERY_METRICS.md`): the scorecard total is M6's qualitative half; the `scaffold.tool` breadcrumb gives M6's quantitative half (by-tool time-to-module). Read together.
- **Cadence**: quarterly. Append each scorecard to the same retro log as the M-series metrics so the trend is visible.
- **Honesty**: small-n and rater-subjective — fix the task, score back-to-back, and treat a *trend* (a tool slipping quarter over quarter) as the signal, never a single quarter as a verdict. Never attribute a low score to the engineer; it measures the tool path, in aggregate.
