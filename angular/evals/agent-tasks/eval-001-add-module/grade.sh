#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"

fail() { echo "FAIL: $1" >&2; exit 1; }

ROOT=src/app/modules/feedback
test -f "$ROOT/module.json" || fail "$ROOT/module.json not found"
test -f "$ROOT/routes.ts" || fail "$ROOT/routes.ts not found"
test -f "$ROOT/MODULE.md" || fail "$ROOT/MODULE.md not found"
grep -q 'authGuard' "$ROOT/routes.ts" || fail "feedback route is not guarded"

SOURCE=$(grep -rEl "feedback\.create" "$ROOT" --include='*.ts' --exclude='*.test.ts' | head -1)
test -n "$SOURCE" || fail "no source invokes stable operation feedback.create"
grep -q 'createOperationMutation' "$SOURCE" || fail "feedback submission does not use createOperationMutation"
grep -qE 'FormGroup|FormControl' "$SOURCE" || fail "feedback form is not explicitly typed"
grep -q 'ChangeDetectionStrategy.OnPush' "$SOURCE" || fail "feedback component is not OnPush"
if grep -qE "ApiClient|HttpClient|fetch\(|['\"]/api/" "$SOURCE"; then
  fail "feedback operation bypasses the typed operation client"
fi

TEST=$(find "$ROOT" -name '*.test.ts' | head -1)
test -n "$TEST" || fail "feedback feature has no colocated .test.ts"
grep -qE 'ok:\s*false|VALIDATION' "$TEST" || fail "test does not cover a declared failure value"

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-001 app-owned operation feature"
