# ADR: Ship monorepo

Status: Accepted, 2026-10-12.

ShipAPI and ShipAngular share one Git repository, pnpm workspace, lockfile, Changesets configuration, and Turborepo build graph. The import is a cleaned source snapshot; historical repositories remain private.

The frameworks retain separate published packages and independent versions. Angular consumes browser-safe contract artifacts and must not import the backend application graph. Joint conformance generates and packs artifacts from this checkout before testing the Angular consumer.

API source retains its existing package directories; Angular lives at `packages/angular`. Its tooling, canonical documentation, and conformance fixtures live under `angular/`, a private tooling workspace. Documentation applications live under `apps/`. This avoids nested workspace packages and preserves the differing API and Angular tool versions.

Framework ADRs and package changelogs retain their history. Repository-operation instructions are superseded by the root release guide. Client applications and deployment material remain outside this repository.

Turborepo caches build outputs, including API modules/libraries as inputs. Tests and type checks run uncached. Reproducibility checks force independent API builds. Publishing remains disabled until repository and package access are configured and release readiness is approved.
