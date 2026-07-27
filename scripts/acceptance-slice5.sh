#!/usr/bin/env bash
# Acceptance test — Slice 5 (Task B5: approval queue UI).
#
# Slice 4 proved the DB-side gates of the approval matrix. This slice proves the
# gates on THE PATH THE BROWSER ACTUALLY TAKES: the anon key plus a signed-in
# user's JWT, hitting PostgREST with the exact projection the page uses.
#
# QUEUE_SELECT is read out of apps/web/src/lib/approval-queue.ts, not restated
# here — an acceptance test that queries different columns than the UI proves
# nothing about the UI.
#
# What only this slice can prove:
#   * the three users! FK hints and the two-level work_requests -> email_messages
#     embed actually resolve (a typo here is a runtime 400 no build catches)
#   * an admin's own JWT can read the queue, and anon / a non-approver cannot
#   * record_approval() over PostgREST enforces the reason, the approver role and
#     the one-decision-per-message rule against the browser's credentials
#   * integration_events stays unreadable from a browser session — the reason the
#     UI reconstructs history from the row instead of the event log
#
# SENDS NOTHING. Every recipient is @example.invalid; mark_message_sent() is
# never called. Rows written are is_fixture=true in the `fixture:` namespace.
#
# Usage: source .env.acceptance && bash scripts/acceptance-slice5.sh
set -u
cd "$(dirname "$0")/.."

URL="https://qgoiacwdntaqeghcyjlw.supabase.co"
ANON="sb_publishable_EDVoHYrGox6sA1CVE3hIBg_vlIRzvHT"
MGMT="https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"
: "${EMAIL:?export EMAIL}"
: "${PASSWORD:?export PASSWORD}"

ORG="2b219aa5-1148-4e3e-a1a0-1725d62b935c"
# Same stable fixture non-approver slice 4 uses (see CONTEXT.md — do not delete).
WORKER="f1000000-0000-4000-8000-000000000001"
RUN=$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)

pass=0; fail=0
check() { if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi }

# Management API, with backoff on throttle only (same contract as slice 4).
sql() {
  local out
  for attempt in 1 2 3 4 5 6; do
    out=$(jq -Rs '{query: .}' <<<"$1" | curl -s --retry 2 --retry-all-errors -X POST "$MGMT" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-)
    if grep -q 'ThrottlerException\|Too Many Requests' <<<"$out"; then
      sleep $((attempt * 8))
      continue
    fi
    break
  done
  printf '%s' "$out"
}
c() { curl -s --retry 2 --retry-all-errors "$@"; }
as_user() {
  printf "begin;\nset local role authenticated;\nset local request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"authenticated\"}';\n%s\n" "$1" "$2"
}

echo "--- slice 5 setup (org $ORG, run $RUN) ---"

# The UI's projection, straight from the module the page imports.
SELECT=$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  -e "import('./apps/web/src/lib/approval-queue.ts').then(m => process.stdout.write(m.QUEUE_SELECT))")
check "0. QUEUE_SELECT read from the UI module (non-empty)" $([ -n "$SELECT" ]; echo $?)

TOK=$(c -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .access_token)
AUTH=(-H "apikey: $ANON" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
ADMIN_ID=$(c "$URL/rest/v1/users?select=id" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" | jq -r '.[0].id')
check "0b. admin signed in (JWT + user id resolved)" \
  $([ -n "$TOK" ] && [ "$TOK" != "null" ] && [ -n "$ADMIN_ID" ] && [ "$ADMIN_ID" != "null" ]; echo $?)

sql "insert into users (id, org_id, role, full_name, is_active)
     values ('$WORKER','$ORG','worker','FIXTURE Non-Approver (slice4)',true)
     on conflict (id) do update set role='worker', is_active=true;" >/dev/null

EM=$(sql "insert into email_messages (org_id, direction, mailbox, from_addr, to_addrs, raw, received_at, is_fixture, graph_message_id, subject, body_text)
          values ('$ORG','inbound','requests@example.invalid','customer@example.invalid',
                  array['requests@example.invalid'], '{}'::jsonb, now(), true,
                  'fixture:slice5-$RUN','Slice 5 fixture','Outlet not working.')
          returning id" | jq -r '.[0].id')
WR=$(sql "insert into work_requests (org_id, email_message_id, classification, customer_name, customer_email, county, zip)
          values ('$ORG','$EM','service_call','Slice5 Fixture','customer@example.invalid','Westchester','10801')
          returning id" | jq -r '.[0].id')

# Two decidable drafts (one to reject, one to approve) and one fail-closed block.
MID_R=$(sql "select create_outbound_draft('$ORG','$WR','service_call_confirmation',
              'fixture:slice5-$RUN-reject','Your service call','Body text',
              array['customer@example.invalid']::text[], null, '{}'::business_role[], true) id" | jq -r '.[0].id')
MID_A=$(sql "select create_outbound_draft('$ORG','$WR','completion_notice',
              'fixture:slice5-$RUN-approve','Work completed','Body text',
              array['customer@example.invalid']::text[], null, '{}'::business_role[], true) id" | jq -r '.[0].id')
MID_B=$(sql "select create_outbound_draft('$ORG','$WR','estimate_proposal',
              'fixture:slice5-$RUN-blocked','Proposal','Body text',
              array['customer@example.invalid']::text[], null, '{}'::business_role[], true) id" | jq -r '.[0].id')
check "0c. setup: 2 drafts + 1 blocked message created via create_outbound_draft" \
  $([ -n "$MID_R" ] && [ "$MID_R" != "null" ] && [ -n "$MID_A" ] && [ "$MID_A" != "null" ] \
    && [ -n "$MID_B" ] && [ "$MID_B" != "null" ]; echo $?)

# ---------------------------------------------------------------------------
# 1. The queue reads: the UI's exact projection, over the browser's credentials.
# ---------------------------------------------------------------------------
Q=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=$SELECT" \
     --data-urlencode "id=eq.$MID_R" "${AUTH[@]}")
check "1. QUEUE_SELECT executes for an admin JWT (no PostgREST error)" \
  $(! grep -q '"code"' <<<"$Q" && [ "$(jq 'length' <<<"$Q")" = "1" ]; echo $?)
check "1b. embeds resolve: matrix row, work request and originating email" \
  $([ "$(jq -r '.[0].message_policies.approver_role' <<<"$Q")" = "office_admin" ] \
    && [ "$(jq -r '.[0].work_requests.customer_name' <<<"$Q")" = "Slice5 Fixture" ] \
    && [ "$(jq -r '.[0].work_requests.email_messages.from_addr' <<<"$Q")" = "customer@example.invalid" ]; echo $?)
check "1c. all three users! FK hints resolve (null on an undecided draft)" \
  $(jq -e 'has("approver") and has("rejector") and has("sender")' <<<"$(jq '.[0]' <<<"$Q")" >/dev/null \
    && [ "$(jq -r '.[0].approver' <<<"$Q")" = "null" ]; echo $?)
check "1d. the row carries what the queue must display" \
  $([ "$(jq -r '.[0].status' <<<"$Q")" = "draft" ] \
    && [ "$(jq -r '.[0].assigned_approver_role' <<<"$Q")" = "office_admin" ] \
    && [ "$(jq -r '.[0].routing_path' <<<"$Q")" = "primary" ] \
    && [ "$(jq -r '.[0].escalated' <<<"$Q")" = "false" ] \
    && [ "$(jq -r '.[0].is_fixture' <<<"$Q")" = "true" ] \
    && [ "$(jq -r '.[0].created_at' <<<"$Q")" != "null" ]; echo $?)

QB=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=$SELECT" \
      --data-urlencode "id=eq.$MID_B" "${AUTH[@]}")
check "1e. the blocked message is VISIBLE in the queue with its reason" \
  $([ "$(jq -r '.[0].status' <<<"$QB")" = "blocked" ] \
    && [ "$(jq -r '.[0].blocked_reason' <<<"$QB")" = "missing_approver_role" ] \
    && [ "$(jq -r '.[0].assigned_approver_role' <<<"$QB")" = "null" ]; echo $?)

# ---------------------------------------------------------------------------
# 2. Unauthorized readers. The queue is admin-only, and anon sees nothing.
# ---------------------------------------------------------------------------
A=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=$SELECT" -H "apikey: $ANON")
check "2. anon (no JWT) reads 0 queue rows" \
  $([ "$(jq 'if type=="array" then length else -1 end' <<<"$A")" = "0" ]; echo $?)
R=$(sql "$(as_user "$WORKER" "select (select count(*) from outbound_messages) m; rollback;")")
check "2b. the fixture worker reads 0 queue rows under RLS" \
  $([ "$(jq -r '.[0].m' <<<"$R")" = "0" ]; echo $?)

# ---------------------------------------------------------------------------
# 3. Capability lookup. The UI asks the DB which roles the human holds — the
#    same function record_approval() asks — instead of deciding for itself.
# ---------------------------------------------------------------------------
CAP_OK=$(c -X POST "$URL/rest/v1/rpc/business_role_matches" "${AUTH[@]}" \
  -d "{\"p_user\":\"$ADMIN_ID\",\"p_role\":\"office_admin\"}")
CAP_NO=$(c -X POST "$URL/rest/v1/rpc/business_role_matches" "${AUTH[@]}" \
  -d "{\"p_user\":\"$ADMIN_ID\",\"p_role\":\"crew_leader\"}")
check "3. business_role_matches(admin,'office_admin') = true over the browser path" \
  $([ "$CAP_OK" = "true" ]; echo $?)
check "3b. business_role_matches(admin,'crew_leader') = false (office roles are not field roles)" \
  $([ "$CAP_NO" = "false" ]; echo $?)
CAP_W=$(c -X POST "$URL/rest/v1/rpc/business_role_matches" "${AUTH[@]}" \
  -d "{\"p_user\":\"$WORKER\",\"p_role\":\"office_admin\"}")
check "3c. business_role_matches(worker,'office_admin') = false (the UI would offer no decision)" \
  $([ "$CAP_W" = "false" ]; echo $?)

# ---------------------------------------------------------------------------
# 4. The queue does not depend on the event log. 0009 declares integration_events
#    service-role-only, so the UI reconstructs history from the message row's own
#    write-once attribution columns instead of querying the event log — no RLS
#    change, no service-role key in the browser.
#
#    NOTE (2026-07-26, found by this slice): the LIVE database carries four
#    UNDECLARED policies on integration_events (org_select/insert/update/delete
#    for `authenticated`) that no migration in this repo creates — orphan-schema
#    residue that 0012 did not clean up. A plain `worker` can therefore read and
#    DELETE audit events today. Tracked as S1 in TASK_BACKLOG (human-gated fix).
#    The queue is unaffected either way BECAUSE it never reads that table — which
#    is exactly what this check pins.
# ---------------------------------------------------------------------------
check "4. the queue's projection names no service-role-only table" \
  $(! grep -q 'integration_events\|approval_outcomes' <<<"$SELECT"; echo $?)
EVP=$(sql "select count(*) c from pg_policies where schemaname='public' and tablename='integration_events'" | jq -r '.[0].c')
echo "      note: integration_events currently carries $EVP client policies (repo declares 0) — see TASK_BACKLOG S1"

# ---------------------------------------------------------------------------
# 5. Rejection requires a reason — enforced against the browser's own call.
# ---------------------------------------------------------------------------
ERR=$(c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" \
  -d "{\"p_message\":\"$MID_R\",\"p_decision\":\"reject\"}")
S=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=status" --data-urlencode "id=eq.$MID_R" "${AUTH[@]}" | jq -r '.[0].status')
check "5. reject without a reason refused over PostgREST" \
  $(grep -q 'rejection must record a reason' <<<"$ERR"; echo $?)
check "5b. the refused rejection left the message in draft" $([ "$S" = "draft" ]; echo $?)

# ---------------------------------------------------------------------------
# 6. Authorized rejection, then the duplicate-decision guard.
# ---------------------------------------------------------------------------
c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" \
  -d "{\"p_message\":\"$MID_R\",\"p_decision\":\"reject\",\"p_reason\":\"slice 5 fixture rejection\"}" >/dev/null
Q=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=$SELECT" \
     --data-urlencode "id=eq.$MID_R" "${AUTH[@]}")
check "6. authorized rejection recorded: status, reason and named rejector" \
  $([ "$(jq -r '.[0].status' <<<"$Q")" = "rejected" ] \
    && [ "$(jq -r '.[0].rejection_reason' <<<"$Q")" = "slice 5 fixture rejection" ] \
    && [ "$(jq -r '.[0].rejected_at' <<<"$Q")" != "null" ] \
    && [ "$(jq -r '.[0].rejector.full_name' <<<"$Q")" != "null" ]; echo $?)
ERR=$(c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" \
  -d "{\"p_message\":\"$MID_R\",\"p_decision\":\"reject\",\"p_reason\":\"second thoughts\"}")
check "6b. a second decision on the same message is refused (duplicate guard)" \
  $(grep -q 'only a draft can be decided' <<<"$ERR"; echo $?)
RR=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=rejection_reason" \
      --data-urlencode "id=eq.$MID_R" "${AUTH[@]}" | jq -r '.[0].rejection_reason')
check "6c. the original decision is unchanged by the duplicate attempt" \
  $([ "$RR" = "slice 5 fixture rejection" ]; echo $?)

# ---------------------------------------------------------------------------
# 7. Authorized approval, and the same duplicate guard on the approve path.
# ---------------------------------------------------------------------------
c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" \
  -d "{\"p_message\":\"$MID_A\",\"p_decision\":\"approve\"}" >/dev/null
Q=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=$SELECT" \
     --data-urlencode "id=eq.$MID_A" "${AUTH[@]}")
check "7. authorized approval recorded: status, timestamp and named approver" \
  $([ "$(jq -r '.[0].status' <<<"$Q")" = "approved" ] \
    && [ "$(jq -r '.[0].approved_at' <<<"$Q")" != "null" ] \
    && [ "$(jq -r '.[0].approver.full_name' <<<"$Q")" != "null" ]; echo $?)
check "7b. approving did NOT send it (sent_at and graph id still null)" \
  $([ "$(jq -r '.[0].sent_at' <<<"$Q")" = "null" ] \
    && [ "$(jq -r '.[0].graph_message_id' <<<"$Q")" = "null" ]; echo $?)
ERR=$(c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" \
  -d "{\"p_message\":\"$MID_A\",\"p_decision\":\"approve\"}")
check "7c. re-approving the same message is refused" \
  $(grep -q 'only a draft can be decided' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 8. A non-approver cannot decide, even holding a valid session for the org.
# ---------------------------------------------------------------------------
ERR=$(sql "$(as_user "$WORKER" "select record_approval('$MID_B','approve');")")
check "8. the fixture worker's approval is refused" \
  $(grep -qE 'does not hold the approver role|only a draft can be decided' <<<"$ERR"; echo $?)
ERR=$(c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" \
  -d "{\"p_message\":\"$MID_B\",\"p_decision\":\"approve\"}")
check "8b. even an admin cannot approve a BLOCKED message (no approver assigned)" \
  $(grep -q 'only a draft can be decided' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 9. The browser cannot write around the gate: outbound_messages has no client
#    insert/update policy, so a direct PATCH changes nothing.
# ---------------------------------------------------------------------------
c -X PATCH "$URL/rest/v1/outbound_messages?id=eq.$MID_B" "${AUTH[@]}" \
  -d '{"status":"approved"}' >/dev/null
S=$(c --get "$URL/rest/v1/outbound_messages" --data-urlencode "select=status" \
     --data-urlencode "id=eq.$MID_B" "${AUTH[@]}" | jq -r '.[0].status')
check "9. direct PATCH from a browser session writes nothing (still blocked)" $([ "$S" = "blocked" ]; echo $?)

# ---------------------------------------------------------------------------
# 10. No-send invariant for this slice.
# ---------------------------------------------------------------------------
N=$(sql "select count(*) c from outbound_messages
          where draft_key like 'fixture:slice5-$RUN%' and (status='sent' or sent_at is not null
                or graph_message_id is not null)" | jq -r '.[0].c')
check "10. nothing this slice created was sent or marked sent" $([ "$N" = "0" ]; echo $?)
N=$(sql "select count(*) c from outbound_messages
          where draft_key like 'fixture:slice5-$RUN%' and exists (
            select 1 from unnest(to_addrs || cc_addrs || bcc_addrs) addr
             where addr not like '%@example.invalid')" | jq -r '.[0].c')
check "10b. every recipient this slice created is @example.invalid" $([ "$N" = "0" ]; echo $?)

echo; echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
