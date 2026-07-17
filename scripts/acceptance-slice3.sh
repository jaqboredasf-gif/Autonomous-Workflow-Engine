#!/usr/bin/env bash
# Acceptance test — Slice 3 (Task B1: intake spine, migration 0011).
# Fixture emails → immutable ingestion → work_requests → events → invariants.
# Classification values are set directly (the AI classifier is Task B2); this
# suite verifies the DB-side spine: dedupe, emergency lock, territory,
# immutability, RLS.
# Usage: source .env.acceptance && bash scripts/acceptance-slice3.sh
set -u

URL="https://qgoiacwdntaqeghcyjlw.supabase.co"
ANON="sb_publishable_EDVoHYrGox6sA1CVE3hIBg_vlIRzvHT"
MGMT="https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"
: "${SUPABASE_SERVICE_ROLE_KEY:?export SUPABASE_SERVICE_ROLE_KEY first}"

ORG="2b219aa5-1148-4e3e-a1a0-1725d62b935c"
RUN=$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)   # per-run graph-id namespace

pass=0; fail=0
check() { # check <name> <condition-result 0|1>
  if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi
}

sql() { jq -Rs '{query: .}' <<<"$1" | curl -s --retry 2 --retry-all-errors -X POST "$MGMT" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-; }

ingest() { # ingest <fixture-file> <graph-suffix>  → response body
  jq -c --arg gid "fix-$RUN-$2" '. + {graph_message_id: $gid}' "fixtures/emails/$1" | \
  curl -s --retry 2 --retry-all-errors -X POST "$URL/rest/v1/email_messages" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" -d @-;
}

body_of() { jq -r .body_text "fixtures/emails/$1"; }

# --- 1: fixture ingestion + request.received event
EM1=$(ingest 01_service_call_basic.json 01 | jq -r '.[0].id')
check "1. fixture email ingested (service role)" $([ "$EM1" != "null" ] && [ -n "$EM1" ]; echo $?)
N=$(sql "select count(*) c from integration_events where event_type='request.received' and entity_id='$EM1'" | jq -r '.[0].c')
check "1b. request.received event emitted" $([ "$N" = "1" ]; echo $?)

# --- 2: exact duplicate (same graph_message_id) → unique violation, single row
DUP=$(ingest 08_duplicate_exact.json 01)   # same suffix ⇒ same graph id as fixture 01
CODE=$(jq -r '.code // empty' <<<"$DUP")
N=$(sql "select count(*) c from email_messages where graph_message_id='fix-$RUN-01'" | jq -r '.[0].c')
check "2. exact duplicate rejected (23505), one row kept" $([ "$CODE" = "23505" ] && [ "$N" = "1" ]; echo $?)

# --- 3: emergency classification → forced escalation + event
EM2=$(ingest 02_emergency_burning_smell.json 02 | jq -r '.[0].id')
WR2=$(sql "insert into work_requests (org_id, email_message_id, classification, customer_name, county)
           values ('$ORG','$EM2','emergency','Frank O''Neill','Westchester') returning id" | jq -r '.[0].id')
ROW=$(sql "select status, urgency from work_requests where id='$WR2'")
check "3. emergency forced to escalated + urgency emergency" \
  $([ "$(jq -r '.[0].status' <<<"$ROW")" = "escalated" ] && [ "$(jq -r '.[0].urgency' <<<"$ROW")" = "emergency" ]; echo $?)
N=$(sql "select count(*) c from integration_events where event_type='request.emergency_escalated' and entity_id='$WR2'" | jq -r '.[0].c')
check "3b. request.emergency_escalated event emitted" $([ "$N" = "1" ]; echo $?)

# --- 4: deterministic keyword net on fixture bodies
K1=$(sql "select is_emergency_text(\$fx\$$(body_of 02_emergency_burning_smell.json)\$fx\$) r" | jq -r '.[0].r')
K2=$(sql "select is_emergency_text(\$fx\$$(body_of 03_emergency_vague_hot_outlet.json)\$fx\$) r" | jq -r '.[0].r')
K3=$(sql "select is_emergency_text(\$fx\$$(body_of 01_service_call_basic.json)\$fx\$) r" | jq -r '.[0].r')
check "4. keyword net: burning smell + hot outlet caught, routine not" \
  $([ "$K1" = "true" ] && [ "$K2" = "true" ] && [ "$K3" = "false" ]; echo $?)

# --- 5: escalated request cannot be scheduled
ERR=$(sql "insert into shifts (org_id, user_id, starts_at, ends_at, work_request_id)
           select '$ORG', id, now(), now()+interval '2 hours', '$WR2' from users limit 1")
check "5. shift for escalated request rejected" \
  $(grep -q "escalated" <<<"$ERR" && ! grep -q '"id"' <<<"$ERR"; echo $?)

# --- 6: ordinary service call → status new, classified event, in-territory
WR1=$(sql "insert into work_requests (org_id, email_message_id, classification, customer_name, county, zip, territory_result)
           values ('$ORG','$EM1','service_call','Maria Lopez','Westchester','10801', check_territory('$ORG','Westchester','10801'))
           returning id, status, territory_result->>'in_territory' as terr")
check "6. service call stays status=new" $([ "$(jq -r '.[0].status' <<<"$WR1")" = "new" ]; echo $?)
check "6b. confirmed in-territory (Westchester sample)" $([ "$(jq -r '.[0].terr' <<<"$WR1")" = "true" ]; echo $?)
WR1ID=$(jq -r '.[0].id' <<<"$WR1")
N=$(sql "select count(*) c from integration_events where event_type='request.classified' and entity_id='$WR1ID'" | jq -r '.[0].c')
check "6c. request.classified event emitted" $([ "$N" = "1" ]; echo $?)

# --- 7: not_a_work_request classifiable, no escalation
EM10=$(ingest 10_not_a_work_request.json 10 | jq -r '.[0].id')
WR10=$(sql "insert into work_requests (org_id, email_message_id, classification, customer_name)
            values ('$ORG','$EM10','not_a_work_request','SupplyHouse Billing') returning id, status, urgency")
check "7. not_a_work_request stored, status=new, no escalation" \
  $([ "$(jq -r '.[0].status' <<<"$WR10")" = "new" ] && [ "$(jq -r '.[0].urgency' <<<"$WR10")" = "standard" ]; echo $?)
WR10ID=$(jq -r '.[0].id' <<<"$WR10")

# --- 8: territory — unknown inputs must be null (never out-of-territory)
T=$(sql "select check_territory('$ORG', null, null)->>'in_territory' r" | jq -r '.[0].r')
check "8. unknown territory → null (never false)" $([ "$T" = "null" ]; echo $?)

# --- 9: confirmed out-of-territory (Nassau not in sample areas)
T=$(sql "select check_territory('$ORG', 'Nassau', '11550')->>'in_territory' r" | jq -r '.[0].r')
check "9. out-of-territory county → false" $([ "$T" = "false" ]; echo $?)

# --- 10: email content immutable; attach is set-once
ERR=$(sql "update email_messages set body_text='tampered' where id='$EM1'")
check "10. email body update rejected (immutable)" $(grep -q "immutable" <<<"$ERR"; echo $?)
OK=$(sql "update email_messages set work_request_id='$WR1ID' where id='$EM1'; select work_request_id from email_messages where id='$EM1'")
check "10b. one-time attach to work request allowed" $([ "$(jq -r '.[0].work_request_id' <<<"$OK")" = "$WR1ID" ]; echo $?)
ERR=$(sql "update email_messages set work_request_id='$WR2' where id='$EM1'")
check "10c. re-attach rejected (set-once)" $(grep -q "set-once" <<<"$ERR"; echo $?)

# --- 11: duplicate status requires the link to the original
ERR=$(sql "update work_requests set status='duplicate' where id='$WR10ID'")
check "11. status=duplicate without link rejected" $(grep -qi "violates check constraint" <<<"$ERR"; echo $?)
OK=$(sql "update work_requests set status='duplicate', duplicate_of_work_request_id='$WR1ID' where id='$WR10ID'; select status from work_requests where id='$WR10ID'")
check "11b. duplicate with link accepted" $([ "$(jq -r '.[0].status' <<<"$OK")" = "duplicate" ]; echo $?)

# --- 12: anon fully blocked from intake tables
ANON_EM=$(curl -s --retry 2 --retry-all-errors "$URL/rest/v1/email_messages?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
ANON_WR=$(curl -s --retry 2 --retry-all-errors "$URL/rest/v1/work_requests?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
check "12. anon blocked from email_messages" $([ "$ANON_EM" = "0" ]; echo $?)
check "12b. anon blocked from work_requests" $([ "$ANON_WR" = "0" ]; echo $?)

echo; echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
