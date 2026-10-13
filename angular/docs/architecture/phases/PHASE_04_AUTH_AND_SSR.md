# Phase 04: Authentication and SSR

- **Status:** Complete — Angular auth and SSR implementation accepted; exact ShipAPI replay remains under C1
- **Checkpoint:** C4 — identity boundary proven
- **Depends on:** C3 vertical slice and agreed ShipAPI auth capabilities
- **Primary owners:** ShipAngular auth owner, ShipAPI auth owner, security reviewer

## Objective

Retain a frontend identity-provider boundary while making credential supply, session operations, failure states, origin policy, and SSR forwarding explicit and safe.

## Target responsibilities

- `AuthService` owns presentation identity state and optional frontend auth actions.
- Provider adapters own provider-specific identity flows.
- Credential capabilities supply a current bearer token or cookie-session policy per attempt.
- ShipAPI operations own session `me`, refresh, sign-out, and any server session behavior.
- Request policy owns origin checks, credentials mode, CSRF, and safe replay.

## Work checklist

### Capability model

- [x] Separate identity state from optional password, magic-link, popup, refresh, and session actions.
- [x] Make unsupported actions discoverable through capabilities rather than runtime “not supported” errors.
- [ ] Confirm the implemented bearer, cookie-session, and CSRF capability vocabulary with ShipAPI.
- [x] Resolve bearer tokens per attempt/reconnect; never capture one at bootstrap.
- [x] Permit one explicit refresh flow without general auth-denial retry.

### Session adapter

- [x] Replace hard-coded URLs/raw fetch with structural auth operations.
- [x] Validate/map user payloads through an application-supplied contract decoder.
- [x] Distinguish unauthenticated from network/protocol/server-indeterminate state.
- [x] Do not mark signed out when the server-side HttpOnly session may remain valid.
- [x] Make initialization explicit rather than hidden constructor I/O.
- [x] Cancel/destroy outstanding probes and prevent stale auth transitions.

### SSR and browser

- [x] Forward only approved cookies/request ID/locale/trace context.
- [x] Never retain request credentials in a platform singleton.
- [x] Ensure cookie credentials and CSRF apply only to configured ShipAPI origins.
- [x] Keep browser-only provider SDKs out of server execution/bundles where appropriate.
- [x] Redact tokens, cookies, CSRF, provider errors, and sensitive validation values in framework-owned errors/diagnostics.

## Required tests and gates

- G0–G5 auth/SSR subset
- reusable adapter/capability conformance suites
- bearer freshness and one-refresh tests
- cookie/CSRF same-origin and cross-origin denial tests
- sign-out success/failure honesty tests
- network/protocol failure does not become unauthenticated
- rapid auth-transition stale suppression
- overlapping SSR A/B credentials/context/cache/cancellation isolation
- log/error/snapshot redaction

Provider tests use fakes; no live Firebase/Auth0/production system is allowed in required CI.

## Checkpoint review

Demonstrate bearer and cookie modes, refresh, authorization denial, failed sign-out, transient network failure, cross-origin request, and two overlapping SSR users. Review both UI state and captured server requests.

## Exit criteria

- [x] Auth state never overstates what is known about the server session.
- [x] Current credentials are resolved for every attempt and reconnect.
- [x] CSRF/cookies cannot leak to third-party origins.
- [x] SSR user isolation and abandonment tests pass.
- [x] Provider-specific actions are capability-checked and conformance-tested.
- [ ] Existing client auth modes are mapped to migration cohorts.
- [ ] Security reviewer approves the redaction and origin model.

## Suggested commits

- `refactor(auth): split auth capabilities`
- `feat(auth): use session operations`
- `fix(auth): preserve failed sign-out state`
- `test(ssr): prove auth context isolation`

Use `fix` only where current user-visible behavior is intentionally corrected; otherwise use `refactor` or `feat` according to the public change.
