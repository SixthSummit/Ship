# Creating app-owned features

ShipAngular no longer publishes a source-copy feature catalog. A “module” is application
organization, not an Angular `NgModule` and not a framework package.

```bash
pnpm exec ng generate @sixthsummit/ship-angular:module products
pnpm exec ng generate @sixthsummit/ship-angular:page products detail
```

The output lives under `src/app/modules/products`, is owned by the application, and is
immediately visible to its compiler, lint, tests, Knip, and Git history.

## Required shape

- standalone OnPush components;
- `inject()` dependency injection;
- signal-first public state;
- typed reactive forms;
- new template control flow;
- lazy route components;
- every route guarded or explicitly public;
- colocated `*.test.ts` tests;
- `MODULE.md` that describes the app feature's surface and decisions.

The generated `module.json` is local feature metadata. It is not an install manifest and
must not trigger recursive code copying or implicit dependency installation.

## ShipAPI data

Inject the application client from `src/api.ts` and use stable operation IDs:

```ts
@Injectable({ providedIn: 'root' })
export class ProductCatalog {
  private readonly client = injectAppShipClient();

  readonly products = createOperationResource(this.client, 'products.list', () => ({
    query: { category: this.category() },
  }));
}
```

Keep `params`, `query`, `headers`, and `body` distinct as defined by the generated contract.
Do not manually reconstruct ShipAPI URLs or serialization. Handle declared failures via
`failure()`/result codes and exceptional transport/protocol failures via `error()`.

Third-party REST stays on the generic root REST surface and must not inherit ShipAPI
credentials or retry policy.

## Verification

```bash
pnpm lint
pnpm type-check
pnpm test:coverage
pnpm e2e
```

Review generated tests for behavior and edge cases. Keep changed-file and global coverage
at or above 80 percent in all metrics.
