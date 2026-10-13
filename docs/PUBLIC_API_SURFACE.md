# ShipAPI v4 public API and compatibility surface

This document defines the stable ShipAPI v4 compatibility surface and focused
operation-package contracts. `main` releases stable versions; `dev` publishes
snapshot prereleases for pending changes. Changesets pre mode is retired.
Use each package manifest and changelog to identify its exact released version.

The exact JavaScript and TypeScript exports of a release are the `exports` maps
and declarations in its packed artifacts. This document defines which of those
paths are product contracts and the behavioral guarantees that span packages.

See [ADR-0012](./rearchitecture/decisions/0012-v4-replacement-and-release-boundary.md)
for the decision to make the operation kernel the v4 target while retaining the
route-first package as a compatibility distribution.

## 1. Stability tiers

| Surface | Tier | v4 guarantee |
| --- | --- | --- |
| Documented exports from `@sixthsummit/ship-core`, `@sixthsummit/ship-hono`, `@sixthsummit/ship-drizzle`, and `@sixthsummit/ship-contract` | Target contract | SemVer-locked after each package reaches stable 1.0 |
| Documented exports from `@sixthsummit/ship-auth-firebase` and `@sixthsummit/ship-observability-otel` | Adapter contract | SemVer-locked after each package reaches stable 1.0 |
| Documented exports from `@sixthsummit/ship-testing` and `@sixthsummit/ship-cli` | Tooling contract | SemVer-locked after each package reaches stable 1.0 |
| Documented exports from `@sixthsummit/ship-realtime-socketio` | Adapter contract (alpha) | `0.1.0-alpha.0`; the kernel `RealtimeBackend` contract and the wire protocol in `docs/v4/realtime.md` are the compatibility surface, SemVer-locked after stable 1.0 |
| `@sixthsummit/ship-api`, `@sixthsummit/ship-api/client`, and `@sixthsummit/ship-api/rate-limit` | v4 compatibility contract | Supported through v4; removal no earlier than v5 and only after the deprecation window |
| Explicit `@sixthsummit/ship-api/{kernel,hono,drizzle,contract*}` re-exports | Migration bridge | Deprecated in favor of focused packages; additive forwarding only |
| Other `@sixthsummit/ship-api/*` deep paths | Reach-through | Not SemVer-locked; do not use for new code |
| Unexported files and package internals | Internal | No compatibility promise |

The focused packages have independent versions. A ShipAPI release manifest
records the exact tested set; consumers pin every direct dependency exactly and
commit a lockfile. Matching version numbers are not used as a substitute for
compatibility evidence.

## 2. Target package ownership

### `@sixthsummit/ship-core`

Owns operations, modules, providers, application compilation, direct execution,
actors, access policy, errors, dependency/effect declarations, unit-of-work
capabilities, and tenant authority. It imports no transport, database, auth
provider, logger, or telemetry runtime.

### `@sixthsummit/ship-hono`

Owns HTTP declarations, JSON/raw/multipart request policies, JSON/text/binary
responses, Hono route projection, credential extraction, and wire-error
translation. Hono is an adapter dependency, not an application type contract.

### `@sixthsummit/ship-drizzle`

Owns executable Drizzle unit-of-work scopes, bounded pagination, semantic audit
and soft-delete mappings, named projections, and authorized tenant repository
construction. It does not own universal CRUD or consumer schemas.

### `@sixthsummit/ship-contract`

The default entry and `/client` and `/manifest` paths are browser-safe. They own
the structural operation client, client result/error/metadata types, and the
portable manifest shape. Backend-only `/application`, `/project`, `/openapi`,
and `/schema` paths own graph-to-contract projection.

### Optional adapters and tools

- `@sixthsummit/ship-auth-firebase` verifies Firebase credentials and delegates
  application actor/permission construction to the consumer.
- `@sixthsummit/ship-observability-otel` owns explicit tracing, Node SDK, and
  Prometheus integration; importing core never starts it.
- `@sixthsummit/ship-testing` owns parity fixtures and disposable real-PostgreSQL
  support and is a development dependency only.
- `@sixthsummit/ship-cli` owns deterministic graph checks, inspection, affected
  surfaces, contract emission, and legacy-route migration accounting.

## 3. Operation and graph contract

An operation owns one stable ID and explicitly declares:

- input schemas by location;
- status-indexed success schemas;
- application error codes, status, safe message, and optional detail schema;
- public, optional-identity, authenticated, or permission access;
- no, read, or write transaction mode;
- typed dependencies and immediate effects; and
- optional transport metadata.

The compiled application graph is the only runtime/tooling source of truth.
Direct execution, Hono routes, client manifests, OpenAPI, CLI diagnostics,
affected-surface queries, and migration mapping must not maintain parallel route
or schema registries.

Stable operation IDs are compatibility contracts. Moving an operation between
modules or changing its HTTP path does not change its ID automatically. Removing
or changing an ID, input location, output status/schema, error code/status,
access semantics, effect delivery, or transaction boundary incompatibly is a
breaking change.

## 4. Access, transactions, and effects

- The executor authoritatively enforces access for HTTP and non-HTTP calls.
- Protected handlers receive a required immutable actor and permission snapshot.
- Optional identity is distinct from an application actor; a verified identity
  may have no domain account.
- A transactional operation receives capabilities built from its active scope,
  never a base connection or transaction controller.
- Nested work joins deterministically, joined failure marks the scope rollback-
  only, and read-to-write escalation is rejected.
- Immediate external effects are declared on the operation and cannot run inside
  a database transaction. Durable delivery uses a transactional inbox/outbox
  record plus a separate dispatcher.

These are behavioral contracts, not documentation conventions.

## 5. HTTP wire contract

The minimum JSON error envelope is:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {
      "issues": [
        { "path": ["body", "name"], "code": "too_small", "message": "Name is required" }
      ]
    }
  }
}
```

Application and framework error codes, their status mappings, and the
`details.issues` container are stable. Human messages may improve without a
major release when code, status, and safe meaning remain compatible. Unexpected
errors never expose provider or stack details on the wire.

HTTP operations declare:

- path, query, lower-case header, and body input locations;
- JSON, raw, or multipart request framing and byte/media/count limits;
- JSON, text, or binary successful response representation; and
- safe response headers and metadata.

Protected requests authenticate and authorize before body reading. The adapter
returns stable validation, payload, media, auth, and internal errors. The
generated client owns path/query/body encoding and response decoding; consumers
must not recreate route-specific serializers.

Query arrays use bracket keys so `tag[]=one`, `tag[]`, and `tag[]=` remain
distinct. The adapter accepts the legacy repeated-key form but rejects mixed
forms. Raw bodies preserve exact bytes. `FormData` retains its Fetch-generated
boundary. Binary responses retain exact bytes, type, disposition, and request
metadata.

SSE responses (ADR 0016) and declared realtime publication (ADR 0017) are
implemented as separate capabilities, not binary body
variants. Current compatibility-package implementations do not become target
contracts merely because they exist.

## 6. Contract projection

The client manifest contains JSON-safe operation metadata and a deterministic
fingerprint. Unsupported schema behavior fails projection with a located
diagnostic rather than degrading to `any`. Non-JSON values require an explicit
client codec and schema declaration.

Declared API failures are discriminated result values. Cancellation, network
failure, invalid manifests, malformed responses, and programmer misuse are
exceptional client errors. Response metadata preserves request ID,
`Retry-After`, ETag, content type, content disposition, and approved additive
headers when present.

The frontend contract is `OperationClient<TContract>`, not `typeof` a Hono
application. ShipAngular owns Angular DI, signals/resources, SSR isolation,
browser transport behavior, and presentation errors around that structural seam.

## 7. Compatibility distribution

`@sixthsummit/ship-api` retains the route-first v4 compatibility surface for incremental
adoption: `createApp`, `createModuleApp`, middleware, Hono `hc()` client types,
`DrizzleEntityService`, request context, legacy errors, jobs, cache, storage,
health, and reference-module/scaffold tooling.

Those APIs remain supported through v4 but are not templates for new kernel
features. A compatibility fix may preserve a current client; it must not make a
second source of operation truth or leak a compatibility type into a focused
package.

Reference modules and libraries copied into an application are consumer-owned
source after copying. Their physical schemas and business behavior are not
framework runtime contracts and are not silently updated by a package bump.

## 8. Historical GA acceptance criteria

The original GA plan required the following evidence. Stable releases now exist;
these criteria are retained as the original acceptance record, not a claim that
all current packages remain unreleased. Application rollout approval is separate.
The original gates were:

- every focused target package reaches a reviewed stable version;
- two real v4 consumers pass exact-package previews and rollback proof;
- ShipAngular passes the joint structural-client contract;
- the packed public-export and dependency-closure gates pass; and
- named owners accept the compatibility, security-response, and release duties.

## 9. Optional capability adapters

Declared jobs/schedules use the kernel contract (ADR 0015) with Drizzle or
BullMQ backends. Webhook operations and provider verifiers follow ADR 0018.
Declared read caching uses the actor/tenant-aware kernel contract and optional
Redis backend (ADR 0019). These are independently packaged capabilities; their
export maps and package changelogs define the versioned surface.
