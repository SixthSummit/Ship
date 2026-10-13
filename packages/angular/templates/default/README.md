# {{APP_NAME}}

{{APP_DESCRIPTION}}

## Getting Started

### Prerequisites

- Node.js 22+ (the SSR runtime targets Node 22)
- pnpm 10.8.1 (Corepack can activate the pinned version)
- A Firebase project for production auth (or set `VITE_MSW=true` for local dev with a mock adapter — no Firebase needed)

### Development

```bash
pnpm install

# With a real Firebase config:
pnpm start

# Or, with MSW + MockAuthAdapter (no Firebase needed):
VITE_MSW=true pnpm start
```

The app boots at `http://localhost:4200`. With SSR enabled (default in v4), the dev server serves the same routing model as production.

### Building & SSR

```bash
# SSR build — the default. Emits dist/{{PROJECT_NAME}}/{browser,server}/.
pnpm build:ssr

# Run the SSR server locally:
pnpm serve:ssr   # listens on $PORT, default 4000
```

### End-to-end (Playwright)

```bash
# One-time browser install:
pnpm e2e:install

# Run the bare-scaffold render/accessibility tripwire. It uses MSW so no
# Firebase project is needed. Add product-specific auth, route, and operation
# cases with each app-owned feature.
pnpm e2e
```

### CI checks locally

```bash
pnpm run ci
```

See `CONTRIBUTING.md`, `.gitmessage`, and `.github/PULL_REQUEST_TEMPLATE.md` for the company commit, test, coverage, review, and rollback standards.

Biome owns TypeScript/JavaScript/JSON formatting and import organization. Angular ESLint
plus ShipAngular's packaged rules own framework semantics; Prettier handles HTML/SCSS.

## Adding app-owned features

```bash
pnpm exec ng generate @sixthsummit/ship-angular:module account --guarded
pnpm exec ng generate @sixthsummit/ship-angular:page account profile
```

Generated UI belongs to this application. Framework upgrades do not overwrite
local features. Shared behavior comes from compiled secondary entrypoints such
as `/operations`, `/auth`, `/forms`, `/upload`, `/download`, `/stream`, and
`/socket`.

## Backend

ShipAngular is **frontend-only**. Its ShipAPI seam is the structural operation
client from `@sixthsummit/ship-angular/operations`; stable operation IDs and
client-safe contracts come from ShipAPI's compiled operation graph. The
`/hono-v4` adapter exists only for migrating pinned legacy sites. Generic REST
helpers remain independent for third-party APIs.

## Configuration

### Environment

`src/environments/environment.ts` (dev) and `src/environments/environment.production.ts` (prod). Replace the placeholder Firebase config in production with your project's values.

For type-safe runtime-validated env access, the framework exports `defineEnv()` (Zod-validated). See `@sixthsummit/ship-angular`'s docs.

### i18n

Markers are extracted via:

```bash
pnpm i18n:extract
```

See `src/locale/README.md` for the full flow. Replace `@angular/localize` with `transloco` if you'd rather translate at runtime.

## Deployment

### Cloud Run (default — SSR)

```bash
gcloud run deploy {{PROJECT_NAME}} --source .
```

`Dockerfile` (multi-stage, distroless final) and `cloudbuild.yaml` (Cloud Build → Artifact Registry → Cloud Run pipeline) ship in this directory. Autoscale-to-zero by default.

### App Engine (alternate — static-only)

`app.yaml` is the static-only opt-out path for teams that don't want SSR. It serves the prerendered `/home` route and the SPA shell from App Engine. Edit `angular.json` to switch `outputMode: 'server'` → `outputMode: 'static'` first; protected routes become client-rendered SPAs.

### Other targets

The SSR server (`src/server.ts`) is plain Express + Angular SSR's `@angular/ssr/node`. It runs anywhere Node 22+ runs (Fly.io, Render, AWS Lambda via the `reqHandler` export, your own VPS).

## Security

The SSR server emits a strict CSP (script-src nonce-based), Trusted Types policy, HSTS, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, and a minimal `Permissions-Policy`. Configured per-request in `src/server.ts` and `src/server-middleware/securityHeaders.ts`. Loosen specific directives only with a documented `# unsafe:reason` comment.

`AuthAdapter` implementations are a trust boundary — see the framework's `SECURITY.md`.

## Project structure

```
src/
├── app/
│   ├── app.component.ts
│   ├── app.config.ts        # browser providers (zoneless, hydration, auth, http)
│   ├── app.config.server.ts # server providers (provideServerRendering + serverRoutes)
│   ├── app.routes.ts        # client routes
│   └── app.routes.server.ts # per-route RenderMode (Prerender | Server | Client)
├── environments/
├── locale/                  # i18n source + translations
├── mocks/                   # MSW handlers (dev + tests)
├── server-middleware/       # CSP, Trusted Types, security headers
├── server.ts                # Node + Express SSR entry
├── main.ts                  # browser entry
├── main.server.ts           # SSR app bootstrap
├── routes.txt               # prerender list
└── styles.scss              # global Tailwind
e2e/                          # Playwright tripwire (sign-in, dashboard, landing)
Dockerfile                    # multi-stage SSR image (Cloud Run / any Node host)
cloudbuild.yaml               # gcloud builds submit pipeline
app.yaml                      # App Engine static-only opt-out
```

## Documentation

- [ShipAngular framework](https://github.com/sixthsummit/ship-angular) — including `AGENTS.md` and `docs/architecture/CONTRACT.md`
- [Angular SSR](https://angular.dev/guide/ssr)
- [Firebase Auth](https://firebase.google.com/docs/auth)

## License

Private — all rights reserved.
