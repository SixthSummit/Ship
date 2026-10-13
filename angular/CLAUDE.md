# CLAUDE.md — ShipAngular framework

Read `AGENTS.md` first. It is canonical; this file only describes the Claude Code
surface shipped with the repository.

## Current architecture

- ShipAngular is frontend-only; ShipAPI is a separate backend framework and release.
- Stable operation IDs and packed browser-safe contract/client artifacts are the primary
  integration contract. Read ADR 0002 before changing it.
- Hono v4 lives only behind the temporary `/hono-v4` compatibility entrypoint.
- Third-party REST remains independent through the legacy root REST APIs.
- App features are generated into `src/app/modules`; there is no published source-copy
  module catalog.
- The workspace uses pnpm, Turbo, Biome for TypeScript formatting/imports, ESLint for
  Angular policy, Prettier for document formats, Vitest, and strict TypeScript.

## Slash commands

| Command                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `/ship:run-vitest`      | Run core Vitest in watch mode                                  |
| `/ship:type-check-both` | Type-check the framework and a generated template when present |
| `/ship:sync-versions`   | Regenerate version mirrors and report drift                    |
| `/ship:release-beta`    | Walk the Changesets prerelease flow; never publishes silently  |
| `/ship:sherpa-brief`    | Produce a read-only QA handoff from the frontend diff          |

## Skills

| Skill                        | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `add-module`                 | Generate an app-owned feature under `src/app/modules`     |
| `signal-rewrite`             | Move a BehaviorSubject-style public surface to signals    |
| `connect-shipapi`            | Wire packed contract/client artifacts into Angular DI     |
| `migrate-hono-to-operations` | Move a pinned v4 route-tree call to a stable operation ID |
| `release-beta`               | Guide a prerelease with explicit confirmation             |

Generated applications receive the app-facing commands, skills, and QA agent from
`../packages/angular/templates/default/.claude/`.

## Framework work

- Root `public-api.ts` is a legacy/public compatibility boundary. Secondary entrypoints
  (`/operations`, `/auth`, `/firebase-auth`, `/forms`, `/upload`, `/download`, `/stream`, `/socket`,
  `/realtime`,
  `/testing`, `/hono-v4`) are independently packaged public contracts.
- Update implementation, type tests, runtime tests, API docs, and a changeset together
  when a public contract changes.
- Never hand-edit `../packages/angular/src/version.ts`.
- `pnpm run ci` is the local integration gate. Use `pnpm test:joint-conformance` only with an
  explicit ShipAPI manifest; it must never silently fall back or skip.

## Hooks and commits

Hooks under `.claude/hooks/` describe the same pnpm checks as the repository scripts.
Use Conventional Commits and keep one logical behavior per commit. A breaking public
change uses `!` or a `BREAKING CHANGE:` footer. Changesets drive releases; do not publish
or open a PR without explicit direction.
