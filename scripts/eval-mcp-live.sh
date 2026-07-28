#!/usr/bin/env bash
# Runner M-LIVE — credential-gated proof of the Supabase MCP data boundary.
#
# READ-ONLY. This suite calls the eight read tools and performs SELECT-only
# oracle queries. It never inserts, updates, deletes, applies SQL or discovers a
# default tenant. AWE_ORG_ID is the explicit process binding.
#
# This suite is intentionally outside the default regression path. Even when
# credentials exist, it refuses unless an operator opts in for this invocation:
#
#   source .env.acceptance
#   AWE_RUN_LIVE_MCP=1 bash scripts/eval-mcp-live.sh
#
# Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AWE_ORG_ID
set -u
cd "$(dirname "$0")/.."

if [ "${AWE_RUN_LIVE_MCP:-}" != "1" ]; then
  echo "Runner M-LIVE: REFUSED (set AWE_RUN_LIVE_MCP=1 for this read-only live proof)"
  exit 2
fi

missing=()
for name in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY AWE_ORG_ID; do
  if [ -z "${!name:-}" ]; then missing+=("$name"); fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Runner M-LIVE: REFUSED (missing env: ${missing[*]})"
  exit 2
fi

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-mcp-live.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner M-LIVE: PASS"
else
  echo "Runner M-LIVE: FAIL (exit $rc)"
fi
exit "$rc"
