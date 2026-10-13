#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

COMPONENT=$(find src/app -name 'chat.component.ts' | head -1)
test -n "$COMPONENT" || fail "chat.component.ts not found"
SOURCE=$(grep -rEl 'agent\.chat\.stream' src/app --include='*.ts' --exclude='*.test.ts' | head -1)
test -n "$SOURCE" || fail "stable chat operation ID is absent"
grep -q "@sixthsummit/ship-angular/stream" "$SOURCE" || fail "wrong stream entrypoint"
grep -q 'createOperationStream' "$SOURCE" || fail "typed operation stream is not used"
grep -q 'injectAppShipRequestPolicy' "$SOURCE" || fail "shared request policy is absent"
for surface in events status failure error start cancel; do
  grep -q "\.${surface}(" "$COMPONENT" "$SOURCE" || fail "chat does not use ${surface}()"
done
grep -q 'ChangeDetectionStrategy.OnPush' "$COMPONENT" || fail "chat page is not OnPush"
if grep -qE 'fetch\(|getReader\(|https?://' "$COMPONENT" "$SOURCE"; then
  fail "chat bypasses generated stream transport"
fi

TEST=$(find "$(dirname "$COMPONENT")" -name '*.test.ts' | head -1)
test -n "$TEST" || fail "chat page has no .test.ts"
grep -qiE 'split|chunk' "$TEST" || fail "test does not cover split SSE input"
grep -qiE 'abort|cancel' "$TEST" || fail "test does not cover cancellation"

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-005 typed operation stream"
