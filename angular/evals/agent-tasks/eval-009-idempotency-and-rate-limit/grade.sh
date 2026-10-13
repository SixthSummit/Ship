#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

SOURCE=$(grep -rEl 'createPolicyClient' src --include='*.ts' --exclude='*.test.ts' | head -1)
test -n "$SOURCE" || fail "policy client configuration not found"
grep -q "@sixthsummit/ship-angular/operations" "$SOURCE" || fail "wrong policy entrypoint"
grep -qE 'polic(y|ies)' "$SOURCE" || fail "generated operation policy map is absent"
grep -q 'allowedOrigins' "$SOURCE" || fail "credential origin allowlist is absent"
grep -q 'credentials' "$SOURCE" || fail "credential capability is absent"
grep -q 'requestId' "$SOURCE" || fail "request ID policy is absent"
if grep -rqE 'idempotencyInterceptor|rateLimitInterceptor' src --include='*.ts' --exclude='*.test.ts'; then
  fail "ShipAPI request behavior is duplicated in Angular interceptors"
fi

TEST=$(grep -rEl 'createPolicyClient' src --include='*.test.ts' | head -1)
test -n "$TEST" || fail "request policy has no .test.ts"
for behavior in Retry-After 401 idempotency sensitive abort refresh; do
  grep -qi "$behavior" "$TEST" || fail "test does not cover $behavior behavior"
done
grep -qiE 'unsafe|mutation' "$TEST" || fail "test does not cover unsafe mutation retry"

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-009 operation request safety"
