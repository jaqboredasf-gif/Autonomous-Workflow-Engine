#!/usr/bin/env bash
# Full automated regression: typechecks, build, MCP smoke, acceptance suites.
# Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_SERVICE_ROLE_KEY=... EMAIL=... PASSWORD=... bash scripts/regression.sh
set -u
cd "$(dirname "$0")/.."
fails=0

step() { echo; echo "== $1"; }

step "mobile typecheck"
(cd apps/mobile && npx tsc --noEmit) && echo OK || fails=$((fails+1))

step "web production build"
(cd apps/web && npm run build >/dev/null 2>&1) && echo OK || fails=$((fails+1))

step "MCP server smoke (initialize + tools/list)"
TOOLS=$( (printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"regression","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) | \
SUPABASE_URL=https://qgoiacwdntaqeghcyjlw.supabase.co node packages/mcp-server/src/index.js 2>/dev/null | \
jq -r 'select(.id==2) | .result.tools | length')
[ "${TOOLS:-0}" -ge 10 ] && echo "OK ($TOOLS tools)" || { echo "FAIL (tools=$TOOLS)"; fails=$((fails+1)); }

step "acceptance slice 1"
bash scripts/acceptance-slice1.sh || fails=$((fails+1))

if [ -f scripts/acceptance-slice2.sh ]; then
  step "acceptance slice 2"
  bash scripts/acceptance-slice2.sh || fails=$((fails+1))
fi

if [ -f scripts/acceptance-slice3.sh ]; then
  step "acceptance slice 3"
  bash scripts/acceptance-slice3.sh || fails=$((fails+1))
fi

if [ -f scripts/eval-intake.sh ]; then
  step "intake eval (baseline, deterministic)"
  bash scripts/eval-intake.sh || fails=$((fails+1))
fi

if [ -f scripts/eval-classification.sh ]; then
  step "classification eval (Runner 2A, deterministic — no model key)"
  bash scripts/eval-classification.sh || fails=$((fails+1))
fi

echo; echo "regression: $([ $fails = 0 ] && echo ALL GREEN || echo "$fails FAILURES")"
[ "$fails" = "0" ]
