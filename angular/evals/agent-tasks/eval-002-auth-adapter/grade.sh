#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

ADAPTER=$(find src -name 'auth0-auth-adapter.ts' | head -1)
test -n "$ADAPTER" || fail "auth0-auth-adapter.ts not found"
TEST="${ADAPTER%.ts}.test.ts"
test -f "$TEST" || fail "auth adapter must use a colocated .test.ts"

grep -q 'implements AuthAdapter' "$ADAPTER" || fail "adapter does not implement AuthAdapter"
grep -q 'Signal<AuthState>' "$ADAPTER" || fail "adapter does not expose Signal<AuthState>"
grep -q 'capabilities' "$ADAPTER" || fail "adapter has no explicit capability map"
grep -q 'initialize' "$ADAPTER" || fail "adapter has no explicit initialization hook"
grep -q 'destroy' "$ADAPTER" || fail "adapter has no teardown hook"
grep -q 'runConformance' "$TEST" || fail "test does not run adapter conformance"
grep -qiE 'refresh|forceRefresh' "$TEST" || fail "test does not exercise current-token refresh"
if grep -qE 'console\.(log|warn|error).*password|console\.(log|warn|error).*token' "$ADAPTER"; then
  fail "adapter logs sensitive credential material"
fi

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-002 capability-based auth adapter"
