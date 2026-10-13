# v3↔v4 parity harness

A differential test harness that pins v4's observable behavior against v3's. Your running v3 apps are a **behavioral-parity oracle** for the undocumented robustness a structural migration silently drops — error envelopes, auth edge cases, pagination bounds, validation strictness, query semantics. That oracle is a **wasting asset**: it disappears as apps migrate off v3 and v3 is decommissioned. Capture it while both stacks exist. The codemod (`ship-api migrate-orm`) proved *structural* migration; this proves *behavioral* parity.

## What ships vs what you capture

The framework ships the **harness** — `runParityFixture()` + `parseParityFixtures()` + the fixture format, exported from the development-only `@sixthsummit/ship-testing` package — plus a set of **`v4-conformance`** fixtures that lock v4's documented contracts today. The high-value **`v3-capture`** fixtures are yours to record from a live v3 app.

Two fixture kinds, one format:

- **`v4-conformance`** — encodes a documented v4 contract (e.g. the error envelope in [Public API Surface §4](../../PUBLIC_API_SURFACE.md)). Ships green; guards v4 against regressing its own contract.
- **`v3-capture`** — recorded from a live v3 app; asserts the migrated v4 build reproduces v3's observed behavior.

## Fixture format

JSONL (one fixture per line, diff-friendly) under `test/parity/fixtures/<area>/*.jsonl`:

```jsonc
{ "id": "auth-missing-token",
  "metadata": { "area": "auth", "surface": "401 on missing token", "source": "v3-capture", "v3App": "example-api" },
  "request": { "method": "GET", "path": "/accounts", "headers": {} },
  "checks": [
    { "path": "status", "equals": 401 },
    { "path": "body.error.code", "equals": "AUTHENTICATION_ERROR" },
    { "path": "headers.retry-after", "exists": false }
  ] }
```

`checks[].path` is a dot-path into the captured response — `status`, `headers.<lowercased>`, or `body.<...>`; each check is `equals` (deep-equal) or `exists` (presence).

## Running

```sh
pnpm run test:parity   # in-process via app.request(); no Docker; gate after `pnpm test`
```

`runParityFixture(app, fixture)` and `parseParityFixtures(jsonl)` are exported from `@sixthsummit/ship-testing`, so a consumer's migrated app runs its own captured fixtures against its v4 app the same way. The old `@sixthsummit/ship-api/testing` path is a deprecated compatibility re-export and requires the testing package to be installed explicitly.

## Capturing v3 fixtures (the wasting-asset step)

Against a running v3 app (staging, or `main` before cut-over):

1. **Exercise** the surface and record the exchange — either `curl` the v3 route and save status/headers/body, or drop a small request/response-logging middleware in front of the v3 app that writes each exchange to a file.
2. **Convert** each exchange into a fixture line: copy the request (method / path / headers / body) and write `checks` for the behaviors that matter (status, error code, key headers, body fields). Set `metadata.source: "v3-capture"` plus `v3App` / `v3Version` for the audit trail.
3. **Redact secrets** (Authorization, cookies, API keys, tokens, passwords) from captured headers/body before committing.
4. **Drop** the line into the matching `test/parity/fixtures/<area>/*.jsonl` and run `pnpm run test:parity` against the v4 build; investigate every divergence.

Prioritize the surfaces a structural migration is most likely to change silently: error envelopes + status codes, auth failure modes, pagination bounds + defaults, validation strictness (unknown-key rejection), and query-operator semantics.
