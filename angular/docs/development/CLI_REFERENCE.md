# CLI and schematics reference

The CLI owns project-level workflows; Angular schematics own code generation inside an
application. Commands shown here use pnpm.

## CLI

```bash
pnpm exec ship-angular create <project-name> [options]
pnpm exec ship-angular update
pnpm exec ship-angular doctor
pnpm exec ship-angular audit-migration [directory] [options]
pnpm exec ship-angular migrate-imports [directory] [--write] [--include-tests]
pnpm exec ship-angular --version
```

`create` options:

| Option              | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `--template <name>` | Template name; default is `default`            |
| `--current-dir`     | Generate into the current empty/safe directory |
| `--skip-install`    | Do not run `pnpm install`                      |
| `--skip-git`        | Do not initialize and commit a Git repository  |

The retired `add`, `modules`, and `libraries` commands are intentionally absent. Features
are generated directly into the app.

### Migration audit

Generate a deterministic, non-mutating inventory before changing a pinned application:

```bash
pnpm exec ship-angular audit-migration . \
  --format json \
  --output ship-angular-migration.json
```

The report identifies copied framework code, legacy URL and Hono calls, overloaded resources,
provider coupling, message-based error handling, manual credentials, custom request policy and
serialization, server-schema imports, multipart/binary/stream/socket transports, optimistic state,
and constructor HTTP injection. It records relative paths and counts but never copies source text,
tokens, headers, request bodies, or response values into the report.

The command deliberately does not rewrite a URL call into a guessed operation. Stable operation
IDs, typed input locations, declared errors, safety/idempotency policy, and transport bindings must
come from the packed ShipAPI contract. Re-run with `--force` only when intentionally replacing an
existing report; otherwise an existing output file is protected. Use `--include-tests` only when
test compatibility patterns should be part of the inventory.

### Safe import migration

Preview deterministic package-boundary changes separately from operation mapping:

```bash
pnpm exec ship-angular migrate-imports .
pnpm exec ship-angular migrate-imports . --write
```

The command currently moves `FirebaseAuthAdapter` from the package root to the optional
`/firebase-auth` entrypoint. It preserves other named root imports, defaults to a non-mutating dry
run, skips tests unless requested, and is idempotent. It reports `SessionAuthAdapter` for manual
work because selecting session operation IDs and mapping user data are application decisions. It
never rewrites URLs, operation IDs, inputs, error branches, or request policy.

## Schematics

```bash
pnpm exec ng add @sixthsummit/ship-angular --skip-install
pnpm exec ng generate @sixthsummit/ship-angular:module orders
pnpm exec ng generate @sixthsummit/ship-angular:page orders detail
pnpm exec ng generate @sixthsummit/ship-angular:auth-adapter Example
pnpm exec ng generate @sixthsummit/ship-angular:api-client \
  --contractPackage=@my-org/ship-api-contract \
  --contractType=AppContract
pnpm exec ng generate @sixthsummit/ship-angular:operation-resource account-detail \
  --operationId=accounts.get
pnpm exec ng generate @sixthsummit/ship-angular:operation-mutation create-account \
  --operationId=accounts.create
pnpm exec ng generate @sixthsummit/ship-angular:operation-auth app \
  --meOperationId=auth.me --signInOperationId=auth.login \
  --signOutOperationId=auth.logout --refreshOperationId=auth.refresh
pnpm exec ng generate @sixthsummit/ship-angular:stream activity \
  --operationId=events.watch --bindingName=activityStreamBinding
pnpm exec ng generate @sixthsummit/ship-angular:download invoice \
  --operationId=invoices.pdf --bindingName=invoiceDownloadBinding
pnpm exec ng generate @sixthsummit/ship-angular:socket notifications \
  --bindingName=notificationsSocketBinding
pnpm exec ng generate @sixthsummit/ship-angular:upload avatar \
  --operationId=accounts.avatar.upload --bindingName=avatarUploadBinding
pnpm exec ng generate @sixthsummit/ship-angular:signed-upload archive \
  --bindingName=archiveSignedUploadBinding
pnpm exec ng generate @sixthsummit/ship-angular:operation-form account \
  --bindingName=accountFormBinding
```

`:module` writes `src/app/modules/<name>` and can wire its routes. `:page` requires an
existing app-owned feature. `:api-client` creates `src/api.ts` with typed client/policy tokens
and one request-scoped boundary provider; it never emits `hc()` or server imports.

`:operation-resource` creates an injectable factory whose caller supplies an explicit,
signal-tracked `InputOf<Contract, Operation>` factory. `:operation-mutation` creates an injectable
mutation state machine whose declared failures remain result values. Both infer data/error/status
types from the contract and generate no URL, serializer, retry policy, `any`, or message parsing.

`:operation-auth` creates the typed binding table and factory for `OperationSessionAuthAdapter`.
It requires callers to supply a validated `mapUser` function and never casts an unknown response
into `AuthUser`. Operation IDs can be overridden or optional actions omitted; TypeScript verifies
every selected operation and input against the installed contract.

`:stream`, `:download`, and `:upload` consume stable operation IDs plus generated bindings.
`:socket` and `:signed-upload` consume bindings that already carry their related operation IDs.
Socket and signed-upload factories require callers to provide explicit approved-origin options;
the generators do not emit an empty or wildcard allowlist. `:operation-form` builds a fresh typed
form from a generated browser-safe binding and never imports a server or schema runtime. None of
these generators invents URLs, credential headers, codecs, statuses, or protocol policy.

All operation-oriented schematics reject malformed names, operation IDs, identifiers, module
specifiers, and destination traversal before rendering. Generated files refuse collisions rather
than overwriting application code.

Use `doctor` as a migration aid, not as proof of compatibility. Full proof is the app's
type/unit/browser/SSR suite plus the framework's packed and joint conformance gates.
