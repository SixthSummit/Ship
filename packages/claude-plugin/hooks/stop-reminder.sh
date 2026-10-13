#!/usr/bin/env bash
# Stop hook — fires when Claude finishes a turn. Surfaces a final
# nudge to run type-check + tests when the session touched ShipAPI
# source. The nudge is emitted as additionalContext so it lands in
# the conversation, not as a tool output that Claude is forced to
# react to (Stop hooks are advisory).
#
# Cheap heuristic: did the recent transcript mention any source
# paths under modules/ or packages/core/src/? If so, surface the
# reminder. Reading transcript_path is the canonical Claude Code
# pattern for Stop hooks.

set -euo pipefail

input="$(cat)"

# transcript_path is in the input; read it if present.
if command -v jq >/dev/null 2>&1; then
  transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty')"
else
  transcript="$(printf '%s' "$input" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("transcript_path",""))' 2>/dev/null)"
fi

# No transcript path — nothing to inspect. Stay silent.
[ -z "$transcript" ] && exit 0
[ ! -f "$transcript" ] && exit 0

# Did this session edit anything under modules/ or packages/core/src/?
# Cheap grep against the transcript file (it's JSONL — each line is
# an event with a tool_input that may carry file_path).
if ! grep -qE '"file_path"\s*:\s*"[^"]*(modules/|packages/core/src/)[^"]*\.ts"' "$transcript" 2>/dev/null; then
  exit 0
fi

# Skip if already reminded once this session (idempotency marker
# stored in /tmp keyed by session_id from the input).
if command -v jq >/dev/null 2>&1; then
  session_id="$(printf '%s' "$input" | jq -r '.session_id // empty')"
else
  session_id="$(printf '%s' "$input" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("session_id",""))' 2>/dev/null)"
fi
if [ -n "$session_id" ]; then
  marker="/tmp/ship-api-stop-reminder-${session_id}"
  if [ -f "$marker" ]; then exit 0; fi
  touch "$marker"
fi

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "ship-api Stop reminder: this session touched ShipAPI source under `modules/` or `packages/core/src/`. Before commit, run:\n\n  npm run type-check  &&  npm run lint  &&  npm test -w @sixthsummit/ship-api\n\nThe pre-commit and CI pipelines run these too — failing locally first is faster than the round trip."
  }
}
JSON
