#!/usr/bin/env bash
# PostToolUse hook — when the recent edit landed in a module file,
# emit a hint to invoke the ship-reviewer subagent. Doesn't run the
# review itself (that would block the agent loop on every edit);
# surfaces an `additionalContext` injection that Claude sees on its
# next turn so it CAN run the review when the user next asks for one.
#
# Receives stdin JSON:
#   { "tool_name": "Edit" | "Write", "tool_input": { "file_path": "..." } }
#
# Outputs JSON to stdout:
#   { "hookSpecificOutput": { "hookEventName": "PostToolUse",
#                             "additionalContext": "..." } }

set -euo pipefail

input="$(cat)"

# Only trigger for paths under modules/ or packages/core/src/.
case "$input" in
  *"modules/"*".ts"*) ;;
  *"packages/core/src/"*".ts"*) ;;
  *) exit 0 ;;
esac

# Skip test files — convention bar is different there.
case "$input" in
  *".test.ts"*) exit 0 ;;
esac

# Extract path (jq if available, python3 fallback).
if command -v jq >/dev/null 2>&1; then
  path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
else
  path="$(printf '%s' "$input" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' 2>/dev/null)"
fi

# Final filter on the parsed path.
case "$path" in
  *"/modules/"*".ts") ;;
  *"/packages/core/src/"*".ts") ;;
  *) exit 0 ;;
esac
case "$path" in *.test.ts) exit 0 ;; esac

# Emit the hint as additionalContext so Claude sees it.
cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "ship-api PostToolUse: edited \`${path}\`. Before declaring this task done, consider invoking the **ship-reviewer** subagent to check this file against v4 conventions (validate() on mutating routes, requireAuth/requirePermission, no raw process.env or console.log, etc.). The user can also run \`/ship:lint-conventions --diff\` once the change is committed."
  }
}
JSON
