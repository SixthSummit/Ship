#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

PROFILE=src/app/modules/dashboard/pages/profile/profile.component.ts
ROUTES=src/app/modules/dashboard/routes.ts
test -f "$PROFILE" || fail "$PROFILE not found"
test -f "$ROUTES" || fail "$ROUTES not found"
grep -q 'ChangeDetectionStrategy.OnPush' "$PROFILE" || fail "profile page is not OnPush"
grep -q 'inject(AuthService)' "$PROFILE" || fail "profile page does not inject AuthService"
grep -qE '\.(user|state)\(\)' "$PROFILE" || fail "profile page does not read auth signal state"
grep -qE "path:\s*['\"]profile['\"]" "$ROUTES" || fail "profile route not found"
grep -qE 'canActivate:\s*\[[^]]*authGuard' "$ROUTES" || fail "profile route is not guarded"

TEST=$(find src/app/modules/dashboard/pages/profile -name '*.test.ts' | head -1)
test -n "$TEST" || fail "profile page has no colocated .test.ts"
grep -qi 'unauthenticated\|null\|empty' "$TEST" || fail "test does not cover an empty identity"

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-003 guarded signal-first profile page"
