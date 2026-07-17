#!/usr/bin/env bash
# Acceptance test — Slice 2: punch immutability + timecard corrections.
# Usage: SUPABASE_ACCESS_TOKEN=... EMAIL=... PASSWORD=... ./scripts/acceptance-slice2.sh
set -u

URL="https://qgoiacwdntaqeghcyjlw.supabase.co"
ANON="sb_publishable_EDVoHYrGox6sA1CVE3hIBg_vlIRzvHT"
MGMT="https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN}"
: "${EMAIL:?export EMAIL}"
: "${PASSWORD:?export PASSWORD}"

ORG="2b219aa5-1148-4e3e-a1a0-1725d62b935c"
SITE="c223ce79-18dd-4a86-8f70-b1137b673fe6"

pass=0; fail=0
check() { if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi }
sql() { jq -Rs '{query: .}' <<<"$1" | curl -s --retry 2 --retry-all-errors -X POST "$MGMT" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-; }
c() { curl -s --retry 2 --retry-all-errors "$@"; }

TOK=$(c -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .access_token)
USER_ID=$(c "$URL/rest/v1/users?select=id" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" | jq -r '.[0].id')
AUTH=(-H "apikey: $ANON" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json")

# fresh closed entry to correct — clock_in 1h in the past so clock_out (now)
# satisfies the clock_out > clock_in check constraint even within one second
CU=$(uuidgen | tr '[:upper:]' '[:lower:]')
CIN=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)
ID=$(c -X POST "$URL/rest/v1/time_entries" "${AUTH[@]}" -H "Prefer: return=representation" \
  -d "{\"org_id\":\"$ORG\",\"user_id\":\"$USER_ID\",\"job_site_id\":\"$SITE\",\"clock_in\":\"$CIN\",\"in_lat\":40.7128,\"in_lng\":-74.006,\"in_accuracy_m\":10,\"device_id\":\"acceptance2\",\"client_uuid\":\"$CU\"}" | jq -r '.[0].id')
c -X PATCH "$URL/rest/v1/time_entries?id=eq.$ID" "${AUTH[@]}" \
  -d "{\"clock_out\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"out_lat\":40.7128,\"out_lng\":-74.006,\"out_accuracy_m\":10}" >/dev/null

# 1. direct clock_in edit blocked
R=$(c -X PATCH "$URL/rest/v1/time_entries?id=eq.$ID" "${AUTH[@]}" -d '{"clock_in":"2026-07-16T00:00:00Z"}')
check "1. direct clock_in edit blocked" $(grep -q 'immutable' <<<"$R"; echo $?)

# 2. changing a set clock_out blocked
R=$(c -X PATCH "$URL/rest/v1/time_entries?id=eq.$ID" "${AUTH[@]}" -d '{"clock_out":"2026-07-16T23:59:00Z"}')
check "2. clock_out overwrite blocked" $(grep -q 'immutable' <<<"$R"; echo $?)

# 3. correction request: original captured server-side + event emitted
# NEWOUT must be after clock_in (check constraint); +30min from now, matches
# PostgREST's returned timestamptz format for the 5b string comparison
NEWOUT=$(date -u -v+30M '+%Y-%m-%dT%H:%M:00+00:00')
CORR=$(c -X POST "$URL/rest/v1/timecard_corrections" "${AUTH[@]}" -H "Prefer: return=representation" \
  -d "{\"org_id\":\"$ORG\",\"time_entry_id\":\"$ID\",\"requested_by\":\"$USER_ID\",
       \"reason\":\"forgot to clock out, left site at 5:15pm\",
       \"corrected_values\":{\"clock_out\":\"$NEWOUT\"}}")
CID=$(jq -r '.[0].id' <<<"$CORR")
ORIG_HAS_OUT=$(jq -r '.[0].original_values | has("clock_out")' <<<"$CORR")
check "3. request created, originals captured" $([ "$CID" != "null" ] && [ "$ORIG_HAS_OUT" = "true" ]; echo $?)
EV=$(sql "select count(*) c from integration_events where event_type='timecard.correction_requested' and entity_id='$CID'" | jq -r '.[0].c')
check "3b. correction_requested event" $([ "$EV" = "1" ]; echo $?)

# 4. anon cannot apply
R=$(c -X POST "$URL/rest/v1/rpc/apply_timecard_correction" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"p_correction_id\":\"$CID\"}")
check "4. anon blocked from applying" $(grep -q 'admin' <<<"$R"; echo $?)

# 5. admin applies via RPC → entry updated, correction approved, event emitted
R=$(c -X POST "$URL/rest/v1/rpc/apply_timecard_correction" "${AUTH[@]}" -d "{\"p_correction_id\":\"$CID\"}")
check "5. admin apply succeeds" $(jq -e '.applied == true' >/dev/null 2>&1 <<<"$R"; echo $?)
GOT=$(c "$URL/rest/v1/time_entries?id=eq.$ID&select=clock_out" "${AUTH[@]}" | jq -r '.[0].clock_out')
check "5b. entry clock_out corrected" $([ "$GOT" = "$NEWOUT" ]; echo $?)
ST=$(c "$URL/rest/v1/timecard_corrections?id=eq.$CID&select=status,approved_by,applied_at" "${AUTH[@]}" | jq -r '.[0].status')
check "5c. correction marked approved" $([ "$ST" = "approved" ]; echo $?)
EV2=$(sql "select count(*) c from integration_events where event_type='timecard.correction_applied' and entity_id='$CID'" | jq -r '.[0].c')
check "5d. correction_applied event" $([ "$EV2" = "1" ]; echo $?)

# 6. double-apply rejected
R=$(c -X POST "$URL/rest/v1/rpc/apply_timecard_correction" "${AUTH[@]}" -d "{\"p_correction_id\":\"$CID\"}")
check "6. double-apply rejected (idempotent)" $(grep -q 'already' <<<"$R"; echo $?)

echo; echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
