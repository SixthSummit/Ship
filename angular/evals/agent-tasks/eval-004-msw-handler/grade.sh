#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

HANDLER=$(grep -rEl "directory\.example\.test/users" src --include='*.ts' --exclude='*.test.ts' | head -1)
test -n "$HANDLER" || fail "third-party users handler not found"
grep -qE 'http\.get|rest\.get' "$HANDLER" || fail "users mock is not an MSW GET handler"
grep -q 'id' "$HANDLER" || fail "mock user has no id"
grep -q 'name' "$HANDLER" || fail "mock user has no name"
grep -q 'email' "$HANDLER" || fail "mock user has no email"

TEST=$(grep -rEl "directory\.example\.test/users" src --include='*.test.ts' | head -1)
test -n "$TEST" || fail "third-party REST behavior has no .test.ts"
grep -qiE 'authorization|cookie|credentials' "$TEST" || fail "test does not assert credential isolation"
if grep -qE 'injectAppShipClient|createOperation(Resource|Mutation)|@sixthsummit/ship-angular/operations' "$HANDLER" "$TEST"; then
  fail "third-party REST was coupled to the ShipAPI operation client"
fi

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-004 independent third-party REST"
