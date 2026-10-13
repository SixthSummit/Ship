#!/usr/bin/env bash
set -euo pipefail

cd "${SHIP_ANGULAR_EVAL_WORKSPACE:?runner must provide an explicit workspace}"
fail() { echo "FAIL: $1" >&2; exit 1; }

SERVICE=$(find src/app -name 'notifications.service.ts' | head -1)
test -n "$SERVICE" || fail "notifications.service.ts not found"
grep -q "@sixthsummit/ship-angular/socket" "$SERVICE" || fail "wrong socket entrypoint"
grep -q 'createOperationSocket' "$SERVICE" || fail "typed operation socket is not used"
grep -q 'notifications.subscribe' "$SERVICE" || fail "stable socket operation ID is absent"
grep -q 'injectAppShipClient' "$SERVICE" || fail "application operation client is absent"
grep -q 'allowedSocketOrigins' "$SERVICE" || fail "socket origin allowlist is absent"
grep -q 'maxMessages' "$SERVICE" || fail "message history is not bounded"
grep -q 'maxQueuedSends' "$SERVICE" || fail "send queue is not bounded"
for surface in messages status closeInfo ticketFailure error; do
  grep -q "\.${surface}" "$SERVICE" || fail "service does not expose ${surface}"
done
if grep -qiE 'bearer.*(query|searchParams)|access_token|token=' "$SERVICE"; then
  fail "socket places bearer credentials in its URL"
fi

TEST=$(find "$(dirname "$SERVICE")" -name '*.test.ts' | head -1)
test -n "$TEST" || fail "notifications service has no .test.ts"
grep -qi 'reconnect' "$TEST" || fail "test does not cover reconnect"
grep -qiE 'server|SSR|unavailable' "$TEST" || fail "test does not cover SSR inertness"
grep -qiE 'protocol|subprotocol' "$TEST" || fail "test does not cover protocol enforcement"

pnpm run ci >/dev/null || fail "pnpm run ci failed"
echo "PASS: eval-006 typed operation socket"
