---
description: Design + scaffold a new ShipAPI v4 module from a feature description. Chains ship-architect (plan) → ship-codegen (implement).
argument-hint: <feature description in plain English>
allowed-tools: Agent, Bash, Read, Write, Edit
---

Design and implement a new v4 module from this description: $ARGUMENTS.

**Step 1.** Hand off to the **ship-architect** subagent to produce a written plan (schema, permissions, routes, validation, service surface). Do not write any code in step 1.

**Step 2.** Show the plan to the user. Ask: "Proceed with this plan?" Wait for confirmation. If they want changes, loop back to ship-architect with the adjustments.

**Step 3.** Once the plan is confirmed, hand off to **ship-codegen** to execute. ship-codegen will:

- Run `ship-api g module <name>` for the skeleton
- Customize each file per the plan
- Write tests (service unit tests + routes integration test)
- Run type-check + lint + tests + build
- Report results

**Step 4.** Surface ship-codegen's verification output. If anything failed, surface the failures plainly — do not claim success.
