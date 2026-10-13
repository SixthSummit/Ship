# Contributing to ShipAPI

Thanks for your interest. ShipAPI is in pre-GA (`4.0.0-alpha.x`) and the surface is still settling, so contributions are most useful in these shapes:

- **Bug reports + reproductions** for the framework, CLI, plugin, or MCP server.
- **Documentation fixes** — typos, broken links, stale code samples, missing concepts.
- **Migration friction reports** — if you're moving a v3 app to v4 and the codemod misses something or the guide skips a step, file it.
- **Security disclosures** — see [`SECURITY.md`](SECURITY.md). Don't open public issues for vulnerabilities.

For larger changes (new modules, new CLI commands, public-API changes), open a discussion or issue first so we can align on scope before you write code.

## Repo layout

The framework + plugin + MCP server are a pnpm-workspaces monorepo:

- `packages/core/` — `@sixthsummit/ship-api` framework
- `packages/claude-plugin/` — `@sixthsummit/ship-api-claude-plugin`
- `packages/mcp-server/` — `@sixthsummit/ship-api-mcp-server`
- `apps/docs/` — Astro + Starlight docs site
- `modules/` — built-in feature modules (accounts, oauth, outbox)
- `libraries/` — shared libraries (ai, chunking, email, weaviate)

Read [`AGENTS.md`](AGENTS.md) before touching code — it's the entry-point doc for the monorepo (where things live, common pitfalls, how to verify your work).

## Development workflow

The repository requires Node.js 22.22 or newer. This matches the minimum runtime required by the
locked test and documentation toolchain; older Node 22 patches are rejected before installation.

```sh
# 1. Fork + clone
git clone git@github.com:<you>/ship-api.git
cd ship-api

# 2. Install
corepack enable
pnpm install --frozen-lockfile

# 3. Branch from main (or v4 during the alpha window)
git checkout -b <type>/<short-description>

# 4. Make changes; check locally
pnpm run verify:fast # Biome + architecture rules + TypeScript + affected tests
pnpm run ci          # merge loop: checks + skills + TypeScript + build + unit tests

# 5. Enable the repository commit template once per clone
git config --local commit.template "$(git rev-parse --show-toplevel)/.gitmessage"

# 6. Commit using Conventional Commits — see below
# 7. Push + open a PR using .github/pull_request_template.md
```

## Conventional Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). Common types:

- `feat:` — new framework / plugin / CLI feature
- `fix:` — bug fix
- `feat!:` / `BREAKING CHANGE:` footer — breaking change
- `docs:` — documentation only
- `refactor:` — code change without behavior change
- `test:` — test-only changes
- `ci:` — CI / workflow / pipeline changes
- `chore:` — tooling, deps, internal cleanup

Scope (optional): area of the change. Common scopes: `(v4)`, `(template)`, `(plugin)`, `(mcp)`, `(cli)`, `(docs)`, `(modules)`, `(libraries)`.

Examples:

```
feat(v4): add idempotency middleware with Redis-backed dedup
fix(cli): handle relative paths in `migrate-orm --write`
ci: cache pnpm artifacts across workflow steps
docs(v4): document subprotocol-header WebSocket auth
```

The repository's [`.gitmessage`](.gitmessage) provides the supported types, subject rules, body prompts, and breaking-change footer. It helps authors compose a valid message but is not enforcement by itself. Changesets—not commit prefixes—control package versions and package changelogs.

## Releases — Changesets

Versions and CHANGELOG entries are managed by [Changesets](https://github.com/changesets/changesets). For any **user-visible** change (new feature, bug fix, breaking change), add a changeset alongside your PR:

```sh
pnpm exec changeset
# answer prompts: which packages, bump type (patch/minor/major), summary
git add .changeset && git commit
```

For PRs that are purely internal (CI tweaks, refactors with no observable impact, docs-only edits in `apps/docs/`), no changeset is needed — Conventional Commit type guides reviewers, but versioning only fires when a changeset is present.

CI previews the combined Changesets plan. Publishing is a separate manual workflow, gated by `SHIP_PUBLISH_ENABLED`: `dev` produces alpha snapshots, while `main` publishes stable versions after a version-bookkeeping PR. Packages target public npmjs. See the [release guide](RELEASE_GUIDE.md) for setup and exact steps.

## PR checklist

Before opening a PR:

- [ ] `pnpm run ci` passes locally
- [ ] Phase-boundary changes run `pnpm run verify` (integration and audit prerequisites documented if unavailable)
- [ ] New code has tests (unit + integration where applicable)
- [ ] AI-generated or AI-assisted tests were reviewed for correctness, meaningful assertions, edge cases, determinism, and cleanup
- [ ] The applicable coverage gate passes and changed production behavior meets the 80% target where measured
- [ ] Public-API changes are reflected in `AGENTS.md` / template README / `.cursor/rules/`
- [ ] If you touched a `.cursor/rules/*.mdc` file, run `pnpm run sync:skills` and commit the regenerated `packages/claude-plugin/skills/*/SKILL.md` files
- [ ] If you touched the `http/` slice, the edge-smoke CI step still passes
- [ ] No secrets, no hardcoded fallbacks, no committed `.env` files

The repository's [pull request template](.github/pull_request_template.md) captures the required contract, test, security, release, risk, rollback, and review evidence. Complete applicable items and explain anything intentionally omitted.

The optional Claude plugin emits a PostToolUse hint after relevant edits suggesting that an agent invoke `ship-reviewer`. The hint does not run the review and does not block a commit or merge. The checks explicitly configured in CI remain authoritative.

## Project conventions

The canonical conventions live in [`.cursor/rules/`](.cursor/rules/) (synced into the Claude plugin's SKILL.md files via `pnpm run sync:skills` + `pnpm run check:skills` drift-detection guard). Read the relevant rule when you touch code in that area:

- [`api.mdc`](.cursor/rules/api.mdc) — RESTful design, response shapes, validation, error handling, never write migrations manually
- [`typescript.mdc`](.cursor/rules/typescript.mdc) — type / null safety, EntityService patterns
- [`testing.mdc`](.cursor/rules/testing.mdc) — Vitest patterns, route + service test shapes
- [`security.mdc`](.cursor/rules/security.mdc) — auth, RBAC, permission system
- [`commits.mdc`](.cursor/rules/commits.mdc) — Conventional Commits + Changesets workflow
- [`project-patterns.mdc`](.cursor/rules/project-patterns.mdc) — module structure, framework-internal layout
- [`template-development.mdc`](.cursor/rules/template-development.mdc) — template-authoring rules

## For maintainers

- [Ship release guide](RELEASE_GUIDE.md) — root Changesets workflow, independent versions, and manually enabled publishing.
- [`docs/maintainers/BUILD_PROCESS.md`](docs/maintainers/BUILD_PROCESS.md) — build-pipeline internals (tsc, post-build dual-emit, lib/ layout).

## Writing `defineEnv` schemas

`defineEnv()` runs at startup, and on failure it logs each Zod issue's `message` via `console.error` so operators see exactly what's broken before the app aborts. Observability stacks (Stackdriver, Datadog, Loki) capture stdout/stderr by default — anything in those messages becomes searchable, indexed, and forwarded.

The framework's `scrubSecrets` helper regex-replaces common secret-value shapes (`sk-…`, `xoxb-…`, JWT, AWS access keys, generic long base64/hex) with `<redacted>` before logging, so a slipped value is the second-best outcome. The first-best outcome is **not putting the value in the message at all**:

```ts
// BAD — interpolates the raw value into the error
SESSION_SECRET: z.string().min(32).refine(
  (v) => v.startsWith("sk-"),
  (v) => ({ message: `got "${v}"` }),   // ← `v` is the secret
),

// GOOD — schema-level constraint; Zod's default message names the rule, not the value
SESSION_SECRET: z.string().min(32).startsWith("sk-"),
```

Stick to schema combinators (`.min()`, `.startsWith()`, `.regex()`, `.url()`) where possible. When a `.refine` is unavoidable, write the error message without `${value}` interpolation.

## Repository scope

Keep this repository specific to the framework. Application code, client
inventories, production schemas, deployment receipts, and private migration plans
belong in their application repositories. Use synthetic, framework-owned fixtures
for regression and conformance tests; do not copy a client's contract or source.

## License

This project is licensed under Apache-2.0 (see [`LICENSE`](LICENSE)). Contributions intentionally submitted for inclusion are provided under the same license unless explicitly stated otherwise. Contributors retain their copyright.
