# Ship

Apache-2.0 frameworks for TypeScript APIs and Angular applications. ShipAPI and ShipAngular share this pnpm/Turborepo workspace while retaining separate packages and independent versions.

## Get started

Use Node 24.15 or newer in the Node 24 line (Node 22.22.2+ and Node 26+ are also supported) and the pinned pnpm 10.34.6.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm run ci
```

`pnpm build` runs the Turbo package graph, including both documentation sites. `pnpm run ci` checks both frameworks and builds current API artifacts for joint conformance. Browser conformance needs Chromium: `pnpm --filter ship-angular exec playwright install chromium`.

## Packages and documentation

- [ShipAPI](API_README.md): operation kernel, HTTP transport, contracts, adapters, and the compatibility API distribution. Source: `packages/`, `modules/`, and `libraries/`.
- [ShipAngular](angular/README.md): signal-first Angular framework and typed operation clients. Source: `packages/angular/`.
- Documentation sites: `apps/docs/` (API) and `apps/angular-docs/` (Angular). Canonical content is in `docs/` and `angular/docs/`.
- [Architecture decisions](docs/architecture/README.md), [changelogs](CHANGELOG.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [releases](RELEASE_GUIDE.md).

```sh
pnpm api:ci                       # API checks, builds, and unit tests
pnpm --filter ship-angular lint   # Angular lint and import checks
pnpm --filter @sixthsummit/ship-angular test
pnpm docs:dev                     # API documentation
pnpm --filter ship-angular docs:dev
pnpm test:joint                   # Fresh API artifacts consumed by Angular
```

Client applications, private deployment records, and customer-specific fixtures do not belong in this repository. Examples and fixtures must be synthetic and framework-focused.

## Release status

This public repository distributes independently versioned packages under `@sixthsummit` on npmjs. Pushes to `dev` and `main` prepare eligible releases automatically; publishing requires approval in the `npm` environment and is gated by `SHIP_PUBLISH_ENABLED`. CI selects API, Angular and docs checks from the complete change set and previews pending Changesets versions. Development and alpha snapshots use `dev`; stable releases use `main`. See the [release guide](RELEASE_GUIDE.md).

## License

[Apache License 2.0](LICENSE). Existing attribution is retained in [NOTICE](NOTICE) and package notices.
