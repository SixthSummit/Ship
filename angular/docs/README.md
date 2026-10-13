# ShipAngular documentation

ShipAngular is the frontend-only Angular framework paired with ShipAPI. The framework
uses a structural operation-client boundary while preserving generic third-party REST.

Start here:

- [TanStack Query guide](guides/TANSTACK_QUERY.md)
- [Architecture decision index](architecture/decisions/README.md)
- [Operation client guide](architecture/OPERATION_CLIENT_GUIDE.md)
- [ADR 0002: operation client contract](architecture/decisions/0002-operation-client-contract.md)
- [Rearchitecture program](architecture/REARCHITECTURE_PROGRAM.md)
- [Testing gates](architecture/TESTING_GATES.md)
- [Hono v4 compatibility](architecture/HONO_V4_COMPATIBILITY.md)
- [Legacy REST compatibility](architecture/LEGACY_REST_COMPATIBILITY.md)
- [Client migration playbook](architecture/CLIENT_MIGRATION_PLAYBOOK.md)

Developer references:

- [Installation](getting-started/INSTALLATION.md)
- [Quick start](getting-started/QUICK_START.md)
- [Project structure](getting-started/PROJECT_STRUCTURE.md)
- [CLI reference](development/CLI_REFERENCE.md)
- [App-owned features](development/CREATING_MODULES.md)
- [Library entrypoints](api/LIBRARY_EXPORTS.md)

Historical audit evidence is preserved in `SHIPANGULAR_REDESIGN_AUDIT.md`,
`CURRENT_COUPLING_MAP.md`, and the superseded `CONTRACT.md`. Do not treat their baseline
commands or Hono examples as current guidance.

Stable packages are released from `main`; `dev` produces alpha snapshots. The retained
ShipAPI fixture under `conformance/joint/` supports the joint gate; an explicit artifact
manifest can test another candidate. See [release guide](../RELEASE_GUIDE.md) and
[package changelog](../../packages/angular/CHANGELOG.md).
