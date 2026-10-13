#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

SOURCE=$(grep -rEl 'OperationSessionAuthAdapter' src --include='*.ts' --exclude='*.test.ts' | head -1)
test -n "$SOURCE" || fail "operation session adapter is not configured"
grep -q "@sixthsummit/ship-angular/auth" "$SOURCE" || fail "wrong session auth entrypoint"
for operation in auth.me auth.signIn auth.refresh auth.signOut; do
  grep -rq "$operation" src --include='*.ts' --exclude='*.test.ts' || fail "missing $operation binding"
done
grep -rq 'provideAppInitializer' src --include='*.ts' || fail "session bootstrap is not explicit"
grep -rqE '\.initialize\(' src --include='*.ts' --exclude='*.test.ts' || fail "identity probe is never started"
grep -rq 'createOperationRequestPolicy' src --include='*.ts' || fail "shared operation policy is absent"
grep -rqE 'credentials:\s*[^,}]*\.credential' src --include='*.ts' || fail "session credential is not connected to request policy"
if grep -rqE "['\"]/auth/(login|refresh|logout|me)" src --include='*.ts' --exclude='*.test.ts'; then
  fail "session integration constructs auth URLs"
fi

TEST=$(grep -rEl 'OperationSessionAuthAdapter' src --include='*.test.ts' | head -1)
test -n "$TEST" || fail "session integration has no .test.ts"
for behavior in refresh CSRF abort cookie; do
  grep -qi "$behavior" "$TEST" || fail "test does not cover $behavior behavior"
done
grep -qiE 'concurrent|request-a|request-b' "$TEST" || fail "test does not cover SSR request isolation"

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-008 operation-backed session auth"
