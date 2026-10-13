# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for vulnerabilities.**

Email `team@sixthsummit.io` with:

- A description of the issue
- Steps to reproduce (or a minimal reproduction repo)
- The affected version (`@sixthsummit/ship-api`, `@sixthsummit/ship-api-claude-plugin`, or `@sixthsummit/ship-api-mcp-server`)
- The impact you've observed or believe is possible

You'll get an acknowledgement within 5 business days. We aim to triage and respond with a remediation plan within 14 days; complex issues may take longer, in which case we'll communicate the timeline.

If you don't hear back within 5 business days, please email again — messages occasionally get filtered.

## Scope

In scope:

- `@sixthsummit/ship-api` (the framework: HTTP, ORM, auth, jobs, observability, scale primitives)
- `@sixthsummit/ship-api-claude-plugin` (agents, hooks, MCP server config)
- `@sixthsummit/ship-api-mcp-server` (MCP tools, including `execute_route`)
- The `ship-api` CLI (`packages/core/cli/`)
- The reference template at `packages/core/templates/default/`

Out of scope:

- **Apps built with ShipAPI** — the framework is a dependency; vulnerabilities in your app's code, configuration, or deployment are out of scope. Report those to the app's maintainers.
- **Transitive vulnerabilities in dependencies we cannot patch** — if a CVE lives in a third-party package, file it with that package's maintainers. We track high/critical findings via `audit-ci` and pin overrides where feasible; some pre-existing transitive findings are documented in [`docs/V4_STATUS.md`](docs/V4_STATUS.md).
- **Self-hosted deployment misconfigurations** — exposed `/dev/routes` in production, missing rate-limit middleware, weak `JWT_SIGNING_KEY`, etc. The framework documents the secure defaults; consumers are responsible for their own configuration.

## Supported versions

ShipAPI is pre-GA (`4.0.0-alpha.x`). Only the latest alpha tag is supported during this window. Once we ship `4.0.0` GA, the support policy will move to "current major + previous major during a documented overlap window."

| Version               | Supported                                                           |
| --------------------- | ------------------------------------------------------------------- |
| `4.0.0-alpha.2`       | ✅                                                                  |
| Older `4.0.0-alpha.x` | ❌ — upgrade                                                        |
| `3.x`                 | ❌ — see [`docs/MIGRATION_V3_TO_V4.md`](docs/MIGRATION_V3_TO_V4.md) |

## No bounty program (yet)

We don't run a paid bounty program during the alpha. We will credit researchers in release notes (with permission) and acknowledge significant disclosures publicly when fixes ship.

## Disclosure

We aim for **coordinated disclosure**: we'll work with you on a timeline that gives users time to upgrade before details are public. The default window is 90 days from initial report to public disclosure, unless the issue is being actively exploited or you have other constraints.

## Security-related conventions

The framework's security defaults are documented in [`.cursor/rules/security.mdc`](.cursor/rules/security.mdc). Highlights:

- **No hardcoded secrets** — `defineEnv(zodSchema)` fail-fasts at boot. Never commit `.env` files.
- **Stateless JWT cookies** with ES256 + key rotation. No `express-session`.
- **CSRF stance is declared, not silent** — see the rule for the default and hardened modes.
- **Rate limit fail-closed by default** when Redis is unavailable.
- **`audit-ci` hard-fails** the CI pipeline on high/critical findings.

If you find a deviation from these defaults in framework or template code, that's a security-relevant bug; please report it via the channel above.

### Inbound webhooks (operation kernel)

Webhooks declared with `defineWebhook` (`@sixthsummit/ship-core`, [ADR-0018](docs/rearchitecture/decisions/0018-inbound-webhook-operations.md)) follow a fixed order that the transport cannot reorder: bounded exact bytes, verifier, provider actor, idempotency claim, then handler or durable receipt. Verification failures answer `401 WEBHOOK_VERIFICATION_FAILED` with no body echo and no stack; store outages answer `503` with `Retry-After` rather than accepting a delivery into memory. Verifiers declare `guarantees: { signature, freshness, replay }` so a scheme's limits are graph-visible; the shared-secret verifier declares all three `false` and must only be used over HTTPS with a dedicated, rotatable secret. URL-signing schemes (Twilio) are verified against the declared `publicBaseUrl`, never the incoming `Host`. Stored events never contain `Authorization`, `Cookie`, or verifier-declared sensitive headers, and the framework never logs raw webhook bodies. A verification bypass, a replay accepted outside the declared idempotency window, or a canonical-URL derivation from request headers is a security-relevant bug.
