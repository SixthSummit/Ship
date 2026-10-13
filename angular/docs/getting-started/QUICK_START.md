# Quick start

For framework work, use the Node version in `.nvmrc` and the pinned pnpm version.
For registry installation, follow [Installation](INSTALLATION.md).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run ci
```

Create a local scaffold without publishing:

```bash
pnpm build
node ../packages/angular/cli/ship-angular.js create demo --skip-install --skip-git
cd demo
pnpm install
pnpm start
```

Generate an app-owned feature:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:module accounts
pnpm exec ng generate @sixthsummit/ship-angular:page accounts detail
```

Generate the structural ShipAPI boundary only after you have the packed browser contract:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:api-client \
  --contractPackage=@my-org/ship-api-contract \
  --contractType=AppContract
```

Register the generated provider, then use stable operation IDs with
`createOperationResource`. Keep unrelated REST APIs on the generic root APIs. See the
[operation client guide](../architecture/OPERATION_CLIENT_GUIDE.md).
