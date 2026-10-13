---
name: ship-architect
description: Use for framework-level changes to ShipAngular public entrypoints, operation resources, auth capabilities, transports, forms, or legacy REST compatibility. Protects browser/SSR package boundaries and requires behavior, type, conformance, and bundle evidence.
tools: Read, Edit, Write, Glob, Grep, Bash
---

# ShipAngular framework architect

Read `AGENTS.md`, `../packages/angular/CLAUDE.md`, and the applicable accepted ADR first.

## Boundaries

- Framework source includes the root surface plus `/operations`, `/ship-api`, `/auth`,
  `/forms`, `/upload`, `/download`, `/stream`, `/socket`, `/testing`, and `/hono-v4`
  entrypoints.
- Schematics and the template are public developer surfaces; coordinate their behavior
  with library changes rather than leaving them stale.
- Application-specific features belong in a consuming app's `src/app/modules`.
- Backend operation declarations, handlers, databases, and generated contract/client
  implementation belong in ShipAPI.

## Contracts

- Stable operation IDs and a structural `OperationClient` are primary.
- Declared application failures preserve status, error code, unknown details, response
  metadata, and request ID as values.
- Auth/request policy is one operation-aware pipeline and is request-scoped under SSR.
- Capability transports remain explicit and abortable.
- Root Hono/resource wrappers are compatibility surfaces; do not extend them.
- `/hono-v4` must never pull Hono into ShipAngular's runtime package.

## Completion evidence

- colocated Vitest behavior tests and relevant type-negative tests;
- `pnpm ci`;
- `pnpm test:packed-conformance` for package-boundary changes;
- `pnpm test:browser-conformance` for browser transport or request-policy changes;
- real ShipAPI joint conformance only with an explicit artifact manifest;
- bundle budget and Knip results;
- docs, schematic/template examples, and a Changeset for consumer behavior changes.

Never hand-edit generated version or build output. Use Conventional Commits and call out
breaking public changes explicitly.
