# App-owned feature modules

ShipAngular no longer publishes a catalog of source-copy feature modules.
Reusable framework behavior is compiled and versioned behind package
entrypoints; application pages and components belong to the application.

The `:module` and `:page` schematics remain. They generate conventional,
app-owned source under `src/app/modules/` and never overwrite locally modified
features during a framework upgrade.

## Why the catalog was removed

The old catalog mixed four incompatible ideas under `modules/*`: reusable UI,
demo applications, provider integrations, and roadmap manifests with no source.
Those files were copied into the published tarball without Angular compilation,
tests, dependency analysis, or reliable upgrade ownership. Concrete defects
included legacy structural directives despite the new-control-flow rule, a
browser-side AI provider implementation, legacy Hono/REST billing shapes, and
six installable-looking stubs that contained no implementation.

Copied source also has no safe automatic update story. Once an application
edits a copied component, the framework cannot distinguish its changes from the
template's changes.

## Disposition of the former catalog

| Former module                                                         | Disposition                                                          | Migration                                                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `core`                                                                | Remove bundled UI kit                                                | Existing copies stay app-owned. Generate a local feature module for new layout work.                                           |
| `auth`                                                                | Remove bundled pages; keep compiled auth services/adapters/guards    | Existing pages stay app-owned. Import framework auth behavior from the root or `/auth`.                                        |
| `forms`                                                               | Remove bundled field components; compile operation forms at `/forms` | Existing components stay app-owned. New operation forms use `createOperationForm`.                                             |
| `dashboard`, `landing`                                                | Remove demos                                                         | Keep/customize existing application copies or generate replacements locally.                                                   |
| `charts`                                                              | Remove optional vendor wrapper                                       | Applications choose and own their chart library; ShipAngular carries no chart dependency.                                      |
| `ai`                                                                  | Remove unsafe provider/browser example                               | Put provider credentials, tools, quotas, and model calls behind ShipAPI operations; consume typed `/stream` events in Angular. |
| `billing`                                                             | Remove handwritten backend example                                   | Model checkout/portal calls as application operations; keep Stripe secrets and webhooks in ShipAPI.                            |
| `admin`, `email`, `notifications`, `profile`, `store-example`, `team` | Remove roadmap stubs                                                 | Track ideas in the roadmap; an empty manifest is not a distributable feature.                                                  |

No removal deletes code already copied into a client repository. Because client
sites are version-pinned, each upgrade can inventory local changes and migrate
them deliberately.

## Generate an app-owned feature

```bash
ng generate @sixthsummit/ship-angular:module orders --guarded
ng generate @sixthsummit/ship-angular:page orders detail --path 'orders/:orderId'
```

The result lives with application source:

```text
src/app/modules/orders/
├── components/
├── pages/
│   ├── index/index.component.ts
│   └── detail/detail.component.ts
├── index.ts
├── routes.ts
├── module.json
└── MODULE.md
```

The module schematic can wire its route array into
`src/app/app.routes.ts`. A generated route is either guarded or must be added to
the application's public-route policy. The files use standalone components,
OnPush change detection, `inject()` DI, signals, typed forms, lazy routes, and
new Angular control flow.

`MODULE.md` is local ownership documentation for humans and agents. It should
state the feature boundary, public exports, backend operations, auth policy,
tests, and intentional extension points. `module.json` is local metadata; it is
not a promise that the framework will update the copied source.

## Package boundary rule

A feature belongs in the published framework only when all of these are true:

- more than one application needs the same behavior rather than merely similar
  markup;
- it has a stable public API and an assigned owner;
- it compiles as an Angular secondary entrypoint or workspace package;
- its tests, coverage, lint, dependency analysis, bundle report, and packed
  consumer proof run in CI; and
- upgrades do not overwrite application-owned files.

Operation-specific behavior currently meets that bar in `/operations`, `/auth`,
`/forms`, `/upload`, `/download`, `/stream`, and `/socket`. The temporary
`/hono-v4` adapter is isolated for migration. Generic REST helpers remain at the
package root for third-party APIs.

## Adding reusable framework code

Do not add another root `modules/<name>` catalog. Propose a secondary entrypoint
or workspace package and include:

1. a public API file and one-way dependency declaration;
2. strict compile-time and runtime tests;
3. a package and forbidden-import assertion;
4. bundle/tree-shaking evidence;
5. a changeset and migration note; and
6. an owner and removal policy.

If the feature is primarily an example, put it in a deterministic fixture app
that builds in CI. If it is product-specific UI, generate it into the consuming
application and treat it as app-owned from its first commit.
