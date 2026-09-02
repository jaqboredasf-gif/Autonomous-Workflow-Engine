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

if [ -f scripts/acceptance-slice4.sh ]; then
  step "acceptance slice 4 (B3 live DB gates: RLS, approval events, send gate, parity)"
  bash scripts/acceptance-slice4.sh || fails=$((fails+1))
  # Slices 1-4 together burn most of the management-API per-minute budget. The
  # suites that follow are also mgmt-heavy (eval-intake, Runner 2A) and a 429
  # there reports as a fake test failure, so let the window drain first. The
  # runners retry with backoff too (scripts/lib/db.mjs); this just avoids paying
  # for it on every fixture.
  echo "   (mgmt-API cooldown 45s before the mgmt-heavy runners)"
  sleep 45
fi

if [ -f scripts/acceptance-slice5.sh ]; then
  step "acceptance slice 5 (B5 approval queue: browser-path RLS, RPC gates, embeds)"
  bash scripts/acceptance-slice5.sh || fails=$((fails+1))
fi

if [ -f scripts/eval-intake.sh ]; then
  step "intake eval (baseline, deterministic)"
  bash scripts/eval-intake.sh || fails=$((fails+1))
fi

if [ -f scripts/eval-classification.sh ]; then
  step "classification eval (Runner 2A, deterministic — no model key)"
  bash scripts/eval-classification.sh || fails=$((fails+1))
fi

if [ -f scripts/lib/validate-migration-0014.mjs ]; then
  step "migration 0014 structural validation (offline lint — no DB)"
  node scripts/lib/validate-migration-0014.mjs >/dev/null 2>&1 && echo OK || { node scripts/lib/validate-migration-0014.mjs; fails=$((fails+1)); }
fi

if [ -f scripts/eval-approval-diff.sh ]; then
  step "approval-diff eval (Runner 3, offline deterministic — no keys, no DB, no network)"
  bash scripts/eval-approval-diff.sh || fails=$((fails+1))
fi

if [ -f scripts/lib/validate-migration-0015.mjs ]; then
  step "migration 0015 structural validation (offline lint + engine/SQL parity — no DB)"
  node scripts/lib/validate-migration-0015.mjs >/dev/null 2>&1 && echo OK || { node scripts/lib/validate-migration-0015.mjs; fails=$((fails+1)); }
fi

if [ -f scripts/eval-approval-matrix.sh ]; then
  step "approval-matrix + outbound-draft eval (Runner 4, offline deterministic — no keys, no DB, no network)"
  bash scripts/eval-approval-matrix.sh || fails=$((fails+1))
fi

if [ -f scripts/eval-approval-queue.sh ]; then
  step "approval-queue eval (Runner 5, offline deterministic — no keys, no DB, no network)"
  bash scripts/eval-approval-queue.sh || fails=$((fails+1))
fi

if [ -f scripts/eval-evidence.sh ]; then
  step "evidence-layer eval (Runner 6, offline deterministic — no keys, no DB, no network)"
  bash scripts/eval-evidence.sh || fails=$((fails+1))
fi

echo; echo "regression: $([ $fails = 0 ] && echo ALL GREEN || echo "$fails FAILURES")"
[ "$fails" = "0" ]
