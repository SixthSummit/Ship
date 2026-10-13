# Security policy

## Reporting a vulnerability

Report suspected security issues privately to **security@sixthsummit.com**. Do not open a
public issue. Expect acknowledgement within 48 hours and an initial assessment within five
business days.

## Supported versions

| Line              | Status       | Security fixes |
| ----------------- | ------------ | -------------- |
| 4.x alpha/beta/GA | Active       | Yes            |
| 3.x and earlier   | Unmaintained | No             |

## Trust boundaries

### Identity providers

An `AuthAdapter` can obtain identity credentials for every signed-in user. Its advertised
`capabilities` must match its implementation, construction must not initiate browser/network
work, and `initialize`/`destroy` own provider lifecycle explicitly.

- Resolve bearer tokens when requested; do not capture one at bootstrap.
- Never log or persist tokens, passwords, raw provider errors, cookies, or unredacted
  validation values in framework code.
- Do not embed credentials in URLs, error messages, storage owned by the framework, or
  user-controlled content.
- Run `runConformance` from `@sixthsummit/ship-angular/testing` and add provider-specific
  refresh, teardown, and redaction tests.
- The optional Firebase implementation is imported from
  `@sixthsummit/ship-angular/firebase-auth`; installing the root framework does not load its
  runtime.

### ShipAPI operation transport

All ShipAPI capabilities use one operation request policy. It owns the credential supplier,
origin allowlist, CSRF, request ID, idempotency, refresh, timeout, cancellation, and approved
retry behavior.

- Allow only exact API origins; credentials must fail closed for every other origin.
- Caller headers cannot override authorization, cookie, CSRF, or idempotency policy.
- Cookie CSRF is enabled only when the operation graph declares it and a current token
  supplier exists.
- Unsafe operations retry only when the graph declares replayability/idempotency and the
  call supplies a stable key.
- Authentication and authorization denial are not general retry signals.
- SSR forwards only explicitly named cookies and headers through a request-scoped injector.
- WebSockets use declared protocols or short-lived tickets; bearer credentials never belong
  in query parameters.

Angular `HttpClient` interceptors remain available for independent third-party REST. The
legacy root fetch wrappers are compatibility surfaces and must not be composed into the new
operation client.

### Browser/server boundary

Never ship server handlers, database/Drizzle types, Firebase Admin, observability backends,
Node-only runtime code, private provider keys, or raw server request objects in a browser
entrypoint. `pnpm test:packed-conformance` enforces the packed package boundary; the joint
ShipAPI manifest adds real cross-repository proof.

### Starter security headers

The generated SSR server emits CSP, Trusted Types, HSTS, referrer, content-type, and
permissions headers. Script execution is nonce-based. The current Tailwind integration has
a narrowly documented inline-style exception in `src/server.ts`; any additional relaxation
requires an `unsafe:reason` comment and security review.

### Supply chain

- pnpm installs are frozen and strict about undeclared dependencies.
- Biome, ESLint, TypeScript, Vitest coverage, packed conformance, bundle budgets, and Knip
  are merge gates.
- Releases use Changesets and target npmjs with trusted publishing and provenance; see the root release guide for launch setup.
- Optional provider dependencies stay in isolated secondary entrypoints.

## Outside the frontend boundary

Server authorization, session issuance, rate limiting, authoritative validation, upload
magic-byte inspection, data storage, and database security belong to ShipAPI or the selected
backend. Browser validation and guards improve UX; they are never an authorization boundary.

## Disclosure targets

After confirmation, aim to release high-severity fixes within 14 days and medium-severity
fixes within 30 days, then publish a GitHub Security Advisory and appropriate credit.
