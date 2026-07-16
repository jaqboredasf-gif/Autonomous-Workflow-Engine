#!/usr/bin/env bash
# Acceptance test — Slice 1 (docs/GAP_ANALYSIS.md §7)
# Runs against the live Supabase project as a real authenticated user.
# Usage: EMAIL=... PASSWORD=... ./scripts/acceptance-slice1.sh
set -u

URL="https://qgoiacwdntaqeghcyjlw.supabase.co"
ANON="sb_publishable_EDVoHYrGox6sA1CVE3hIBg_vlIRzvHT"
MGMT="https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"
: "${EMAIL:?export EMAIL}"
: "${PASSWORD:?export PASSWORD}"

ORG="2b219aa5-1148-4e3e-a1a0-1725d62b935c"
SITE="c223ce79-18dd-4a86-8f70-b1137b673fe6"   # Demo Jobsite 40.7128,-74.006 r=150m

pass=0; fail=0
check() { # check <name> <condition-result 0|1>
  if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi
}

sql() { jq -Rs '{query: .}' <<<"$1" | curl -s -X POST "$MGMT" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-; }

TOK=$(curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .access_token)
USER_ID=$(curl -s "$URL/rest/v1/users?select=id" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" | jq -r '.[0].id')

CU=$(uuidgen | tr '[:upper:]' '[:lower:]')

# --- 1+2: punch in ~210m from center (60m past fence) with 80m accuracy → inside
ROW=$(curl -s -X POST "$URL/rest/v1/time_entries" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "{\"org_id\":\"$ORG\",\"user_id\":\"$USER_ID\",\"job_site_id\":\"$SITE\",
       \"clock_in\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"in_lat\":40.71469,\"in_lng\":-74.006,
       \"in_accuracy_m\":80,\"device_id\":\"acceptance\",\"client_uuid\":\"$CU\"}")
ID=$(jq -r '.[0].id' <<<"$ROW")
FLAG=$(jq -r '.[0].in_geo_flag' <<<"$ROW")
DIST=$(jq -r '.[0].in_distance_m | floor' <<<"$ROW")
check "1. accuracy + distance stored (distance ${DIST}m)" $([ "$DIST" -gt 150 ] && [ "$DIST" -lt 300 ]; echo $?)
check "2. accuracy benefit of doubt → inside" $([ "$FLAG" = "inside" ]; echo $?)
CREATED=$(sql "select count(*) c from integration_events where event_type='punch.created' and entity_id='$ID'" | jq -r '.[0].c')
check "1b. punch.created event emitted" $([ "$CREATED" = "1" ]; echo $?)

# --- 3: clock out 2km away, 10m accuracy → outside + flagged event exactly once
curl -s -X PATCH "$URL/rest/v1/time_entries?id=eq.$ID" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -d "{\"clock_out\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"out_lat\":40.7308,\"out_lng\":-74.006,\"out_accuracy_m\":10}" >/dev/null
# second no-op update must not duplicate the flag event
curl -s -X PATCH "$URL/rest/v1/time_entries?id=eq.$ID" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -d '{"notes":"acceptance touch"}' >/dev/null
OUTFLAG=$(curl -s "$URL/rest/v1/time_entries?id=eq.$ID&select=out_geo_flag" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" | jq -r '.[0].out_geo_flag')
check "3. tight accuracy far away → outside" $([ "$OUTFLAG" = "outside" ]; echo $?)
FLAGGED=$(sql "select count(*) c from integration_events where event_type='punch.flagged' and entity_id='$ID'" | jq -r '.[0].c')
check "3b. punch.flagged emitted exactly once" $([ "$FLAGGED" = "1" ]; echo $?)

# --- 4: completion report with return trip → both events
CR=$(curl -s -X POST "$URL/rest/v1/completion_reports" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "{\"org_id\":\"$ORG\",\"user_id\":\"$USER_ID\",\"time_entry_id\":\"$ID\",\"job_site_id\":\"$SITE\",
       \"work_complete\":false,\"return_trip_needed\":true,\"return_trip_reason\":\"waiting on parts\",
       \"materials_used\":\"12/2 romex 50ft\",\"notes\":\"acceptance test\"}")
CRID=$(jq -r '.[0].id' <<<"$CR")
check "4. worker can insert own completion (RLS)" $([ "$CRID" != "null" ] && [ -n "$CRID" ]; echo $?)
EV=$(sql "select event_type from integration_events where entity_id='$CRID' order by event_type" | jq -r 'map(.event_type)|join(",")')
check "4b. job.completed + return_trip events" $([ "$EV" = "completion.return_trip_required,job.completed" ]; echo $?)

# --- 5: anon cannot read events or completions
ANON_EV=$(curl -s "$URL/rest/v1/integration_events?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
ANON_CR=$(curl -s "$URL/rest/v1/completion_reports?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
check "5. anon blocked from integration_events" $([ "$ANON_EV" = "0" ]; echo $?)
check "5b. anon blocked from completion_reports" $([ "$ANON_CR" = "0" ]; echo $?)

echo; echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
