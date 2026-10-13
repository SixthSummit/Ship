# `@sixthsummit/ship-cli`

Deterministic tooling over a compiled Ship application. The package owns the
new architecture's scaffold, `check`, `inspect`, `affected`, `contract`, and
migration-accounting commands. It can be installed without the legacy module
generator or ORM codemod toolchain.

```sh
pnpm dlx @sixthsummit/ship-cli create my-api
cd my-api
pnpm run verify

ship-api check --format json --emit
ship-api inspect operation accounts.read
ship-api affected provider platform.clock
ship-api contract --api-version 1.0.0
ship-api migrate-routes --catalog legacy-routes.json --mapping route-mapping.json
```

`create` emits a minimal operation application with exact Ship package pins,
Biome, strict TypeScript, unit and HTTP integration tests, an enforced 80%
coverage floor, graph/contract commands, `AGENTS.md`, `.gitmessage`, and a pull
request template. The package's generated release manifest binds every scaffold
to the package versions from the same reviewed release build. The packed-package
gate creates the project outside the workspace, installs physical archives, and
runs the generated `verify` command.

Use `--skip-install` in automation. Use `--current-dir` only in an empty
directory; the command refuses unsafe names and existing targets.

Graph commands load the named `app` export from `ship.config.ts`. Exit code `0`
means success, `1` means the application graph or contract is invalid, and `2`
means usage or application loading failed.

`inspect app` and `inspect module <id>` also list the permission slugs the
operations (and HTTP job triggers) demand, with framework-introduced slugs
(`ship.outbox:manage`, `ship.jobs:manage`, `ship.webhooks:replay`) under
`framework permissions` and the operations that need each; `--format json`
carries the same list as `permissions`. `inspect operation` renders scoped
invalidations as `tag (actor)` / `tag (tenant)`.

`migrate-routes` treats the legacy catalog as migration-only evidence. Every
catalogued route must have exactly one mapping to an HTTP operation with the
same method and path, or one removal carrying a decision ID and reason. The
command fails on a stale catalog revision, duplicate/unknown disposition,
missing/non-HTTP operation, or wire-method/path drift.
