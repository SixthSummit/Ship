#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

UPLOAD=$(grep -rEl 'accounts\.avatar\.upload' src/app --include='*upload*.component.ts' | head -1)
test -n "$UPLOAD" || fail "typed avatar upload component not found"
grep -q "@sixthsummit/ship-angular/upload" "$UPLOAD" || fail "wrong upload entrypoint"
grep -q 'createOperationUpload' "$UPLOAD" || fail "typed operation upload is not used"
grep -q 'injectAppShipRequestPolicy' "$UPLOAD" || fail "shared request policy is absent"
grep -q '\.fields' "$UPLOAD" || fail "UI does not consume generated field constraints"
for surface in progress pending failure error cancel; do
  grep -q "\.${surface}(" "$UPLOAD" || fail "upload does not use ${surface}()"
done
if grep -qE 'new XMLHttpRequest|new FormData|Authorization|X-CSRF' "$UPLOAD"; then
  fail "component reconstructs transport or credential policy"
fi

TEST=$(find "$(dirname "$UPLOAD")" -name '*.test.ts' | head -1)
test -n "$TEST" || fail "upload component has no .test.ts"
for behavior in progress cancel constraint CSRF failure; do
  grep -qi "$behavior" "$TEST" || fail "test does not cover $behavior behavior"
done

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-007 typed operation upload"
