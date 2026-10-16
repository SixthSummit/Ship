# ShipAngular architecture decisions

Public documentation retains framework decisions and omits private application
identities, deployment records, and client-specific acceptance evidence.

Accepted ADRs retain their original context; later implementation notes clarify
what changed without rewriting the decision history.

| ADR                                           | Status   | Decision                                                                                       |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| [0002](0002-operation-client-contract.md)     | Accepted | Structural operation-client contract; supersedes the Hono-primary decision in `../CONTRACT.md` |
| [0003](0003-client-safe-form-bindings.md)     | Accepted | Generated client-safe primitive form bindings                                                  |
| [0004](0004-streaming-response-mode.md)       | Accepted | Manifest-declared SSE response mode                                                            |
| [0005](0005-declared-realtime-publication.md) | Accepted | Manifest-declared realtime subscriptions                                                       |

| [0006](0006-web-push.md) | Accepted | Optional service-worker Web Push and application-owned subscription persistence |

The historical Hono decision was recorded in `../CONTRACT.md`; this directory
has no numbered ADR 0001. The optional query integration is documented in
[the query guide](../../guides/TANSTACK_QUERY.md), with implementation evidence
under `docs/evidence/`; no separate accepted query ADR is claimed here.
