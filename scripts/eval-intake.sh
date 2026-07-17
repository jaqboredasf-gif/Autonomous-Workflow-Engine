#!/usr/bin/env bash
# Baseline deterministic eval (Runner 1, docs/testing/EVAL_STRATEGY.md).
# No model calls. Evaluates the deterministic safety layer against ground-truth
# labels on every regression run:
#   - keyword-net recall on keyword_net_expected fixtures  (gate: 100%)
#   - keyword-net false positives on clean fixtures        (gate: 0)
#   - check_territory verdict vs expected                  (gate: 100%)
# Usage: source .env.acceptance && bash scripts/eval-intake.sh
set -u
cd "$(dirname "$0")/.."

MGMT="https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"
ORG="2b219aa5-1148-4e3e-a1a0-1725d62b935c"
LABELS="${LABELS:-fixtures/emails/labels.json}"

pass=0; fail=0
check() { if [ "$2" = "0" ]; then pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi }
sql() { jq -Rs '{query: .}' <<<"$1" | curl -s --retry 2 --retry-all-errors -X POST "$MGMT" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-; }

for f in $(jq -r 'keys[] | select(startswith("_") | not)' "$LABELS"); do
  body=$(jq -r .body_text "fixtures/emails/$f")
  kw_expected=$(jq -r --arg f "$f" '.[$f].keyword_net_expected' "$LABELS")
  county=$(jq -r --arg f "$f" '.[$f].county // empty' "$LABELS")
  zip=$(jq -r --arg f "$f" '.[$f].zip // empty' "$LABELS")
  terr_expected=$(jq -r --arg f "$f" '.[$f].in_territory' "$LABELS")

  county_sql="null"; [ -n "$county" ] && county_sql="\$gt\$$county\$gt\$"
  zip_sql="null";    [ -n "$zip" ]    && zip_sql="\$gt\$$zip\$gt\$"
  row=$(sql "select is_emergency_text(\$fx\$$body\$fx\$) kw,
                    coalesce(check_territory('$ORG', $county_sql, $zip_sql)->>'in_territory','null') terr")
  kw=$(jq -r '.[0].kw' <<<"$row"); terr=$(jq -r '.[0].terr' <<<"$row")

  check "$f keyword net: expected $kw_expected got $kw" $([ "$kw" = "$kw_expected" ]; echo $?)
  check "$f territory: expected $terr_expected got $terr" $([ "$terr" = "$terr_expected" ]; echo $?)
done

echo "eval-intake (baseline): passed=$pass failed=$fail"
[ "$fail" = "0" ]
