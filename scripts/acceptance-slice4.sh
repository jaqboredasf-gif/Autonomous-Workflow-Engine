#!/usr/bin/env bash
# Acceptance test — Slice 4 (Task B3-live: approval matrix + outbound drafts,
# migrations 0014 + 0015 applied live).
#
# Proves the DB-side gates that the offline lint and Runner 4 CANNOT: RLS denial
# for non-approvers, the approve -> message.approved event, `sent` being
# unreachable without an approval row, final_invoice refusing auto mode, and
# duplicate draft_key returning 23505. Plus live SQL/JS routing parity, which
# retires B3's dual-implementation risk.
#
# SENDS NOTHING. Every recipient is @example.invalid; mark_message_sent() is
# bookkeeping only. Rows written are is_fixture=true in the `fixture:` namespace.
#
# Usage: source .env.acceptance && bash scripts/acceptance-slice4.sh
set -u

URL="https://qgoiacwdntaqeghcyjlw.supabase.co"
ANON="sb_publishable_EDVoHYrGox6sA1CVE3hIBg_vlIRzvHT"
MGMT="https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"
: "${SUPABASE_SERVICE_ROLE_KEY:?export SUPABASE_SERVICE_ROLE_KEY first}"
: "${EMAIL:?export EMAIL}"
: "${PASSWORD:?export PASSWORD}"

ORG="2b219aa5-1148-4e3e-a1a0-1725d62b935c"
# Stable fixture non-approver. No auth.users row is needed: current_role_is() /
# business_role_matches() read public.users, and auth.uid() reads the JWT claim.
WORKER="f1000000-0000-4000-8000-000000000001"
RUN=$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)   # per-run draft_key namespace

pass=0; fail=0
check() { if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi }
# This suite issues ~60 management-API queries. That API rate-limits per minute,
# and a 429 is a harness throttle rather than a test result — so back off and
# retry on throttle only. Real SQL errors are returned untouched (the checks below
# assert on their text).
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

# Impersonate a public.users row inside an UNCOMMITTED transaction. RLS applies
# because the session role becomes `authenticated`; nothing persists because the
# transaction is never committed (a raising statement aborts it, and the
# non-raising variants end in rollback).
as_user() { # as_user <user-uuid> <sql>
  printf "begin;\nset local role authenticated;\nset local request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"authenticated\"}';\n%s\n" "$1" "$2"
}
as_service_user() { # internal service path with explicit human attribution
  printf "begin;\nset local role service_role;\nset local request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"service_role\"}';\n%s\ncommit;\n" "$1" "$2"
}

echo "--- slice 4 setup (org $ORG, run $RUN) ---"

TOK=$(c -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .access_token)
AUTH=(-H "apikey: $ANON" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json")
ADMIN_ID=$(c "$URL/rest/v1/users?select=id" -H "apikey: $ANON" -H "Authorization: Bearer $TOK" | jq -r '.[0].id')

# Fixture non-approver (idempotent).
sql "insert into users (id, org_id, role, full_name, is_active)
     values ('$WORKER','$ORG','worker','FIXTURE Non-Approver (slice4)',true)
     on conflict (id) do update set role='worker', is_active=true;" >/dev/null

# A work request to hang messages off (exercises the FK + the active-unique index).
EM=$(sql "insert into email_messages (org_id, direction, mailbox, from_addr, to_addrs, raw, received_at, is_fixture, graph_message_id, subject, body_text)
          values ('$ORG','inbound','requests@example.invalid','customer@example.invalid',
                  array['requests@example.invalid'], '{}'::jsonb, now(), true,
                  'fixture:slice4-$RUN','Slice 4 fixture','Outlet not working.')
          returning id" | jq -r '.[0].id')
WR=$(sql "insert into work_requests (org_id, email_message_id, classification, customer_name, county, zip)
          values ('$ORG','$EM','service_call','Slice4 Fixture','Westchester','10801')
          returning id" | jq -r '.[0].id')
check "0. setup: fixture email + work_request created" \
  $([ "$EM" != "null" ] && [ -n "$EM" ] && [ "$WR" != "null" ] && [ -n "$WR" ]; echo $?)

# ---------------------------------------------------------------------------
# 1. create_outbound_draft: the only birth path. Draft + routing evidence + event.
# ---------------------------------------------------------------------------
MID=$(sql "select create_outbound_draft('$ORG','$WR','service_call_confirmation',
             'fixture:slice4-$RUN-confirm','Your service call','Body text',
             array['customer@example.invalid']::text[], null, '{}'::business_role[], true) id" | jq -r '.[0].id')
ROW=$(sql "select status, assigned_approver_role, routing_path, escalated, is_fixture,
                  approved_by, sent_at, graph_message_id
             from outbound_messages where id='$MID'")
check "1. draft created, status=draft, routed to office_admin/primary" \
  $([ "$(jq -r '.[0].status' <<<"$ROW")" = "draft" ] \
    && [ "$(jq -r '.[0].assigned_approver_role' <<<"$ROW")" = "office_admin" ] \
    && [ "$(jq -r '.[0].routing_path' <<<"$ROW")" = "primary" ] \
    && [ "$(jq -r '.[0].escalated' <<<"$ROW")" = "false" ]; echo $?)
check "1b. fresh draft carries no decision and no graph id" \
  $([ "$(jq -r '.[0].approved_by' <<<"$ROW")" = "null" ] \
    && [ "$(jq -r '.[0].sent_at' <<<"$ROW")" = "null" ] \
    && [ "$(jq -r '.[0].graph_message_id' <<<"$ROW")" = "null" ]; echo $?)
N=$(sql "select count(*) c from integration_events
          where event_type='message.draft_created' and entity_id='$MID'" | jq -r '.[0].c')
check "1c. message.draft_created event emitted exactly once" $([ "$N" = "1" ]; echo $?)

# ---------------------------------------------------------------------------
# 2. Duplicate draft_key. RPC is idempotent; a direct insert is 23505.
# ---------------------------------------------------------------------------
MID2=$(sql "select create_outbound_draft('$ORG','$WR','service_call_confirmation',
              'fixture:slice4-$RUN-confirm','Different subject','Different body',
              array['customer@example.invalid']::text[], null, '{}'::business_role[], true) id" | jq -r '.[0].id')
N=$(sql "select count(*) c from outbound_messages where org_id='$ORG' and draft_key='fixture:slice4-$RUN-confirm'" | jq -r '.[0].c')
check "2. duplicate draft_key via RPC returns the same row (idempotent, no 2nd row)" \
  $([ "$MID2" = "$MID" ] && [ "$N" = "1" ]; echo $?)
ERR=$(sql "insert into outbound_messages (org_id, work_request_id, message_type, draft_key, to_addrs, is_fixture)
           values ('$ORG','$WR','missing_info_request','fixture:slice4-$RUN-confirm',
                   array['customer@example.invalid']::text[], true)")
check "2b. duplicate draft_key via direct insert → 23505 unique violation" \
  $(grep -q '23505' <<<"$ERR" && ! grep -q '"id"' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 3. Fail-closed: unknown approver / unknown limit BLOCK. Live proof that the
#    unanswered boss §3 limits and the open estimate_proposal approver
#    [ASSUMPTION] deny rather than guess.
# ---------------------------------------------------------------------------
BID=$(sql "select create_outbound_draft('$ORG','$WR','estimate_proposal',
             'fixture:slice4-$RUN-estimate','Proposal','Body',
             array['customer@example.invalid']::text[], null, '{}'::business_role[], true) id" | jq -r '.[0].id')
ROW=$(sql "select status, blocked_reason, assigned_approver_role from outbound_messages where id='$BID'")
check "3. estimate_proposal (approver_role NULL) → blocked/missing_approver_role" \
  $([ "$(jq -r '.[0].status' <<<"$ROW")" = "blocked" ] \
    && [ "$(jq -r '.[0].blocked_reason' <<<"$ROW")" = "missing_approver_role" ] \
    && [ "$(jq -r '.[0].assigned_approver_role' <<<"$ROW")" = "null" ]; echo $?)
N=$(sql "select count(*) c from integration_events where event_type='message.blocked' and entity_id='$BID'" | jq -r '.[0].c')
check "3b. message.blocked event emitted for the blocked draft" $([ "$N" = "1" ]; echo $?)
BID2=$(sql "select create_outbound_draft('$ORG','$WR','change_order',
              'fixture:slice4-$RUN-co','Change order','Body',
              array['customer@example.invalid']::text[], 250000, '{}'::business_role[], true) id" | jq -r '.[0].id')
ROW=$(sql "select status, blocked_reason from outbound_messages where id='$BID2'")
check "3c. amount-bearing message with limit NULL → blocked/missing_approval_limit" \
  $([ "$(jq -r '.[0].status' <<<"$ROW")" = "blocked" ] \
    && [ "$(jq -r '.[0].blocked_reason' <<<"$ROW")" = "missing_approval_limit" ]; echo $?)

# ---------------------------------------------------------------------------
# 4. RLS: a non-approver cannot see the queue and cannot decide on it.
# ---------------------------------------------------------------------------
R=$(sql "$(as_user "$WORKER" "select (select count(*) from outbound_messages) m,
                                     (select count(*) from message_policies) p,
                                     current_role_is('admin') adm;
rollback;")")
check "4. worker (non-approver) sees 0 outbound_messages under RLS" \
  $([ "$(jq -r '.[0].m' <<<"$R")" = "0" ]; echo $?)
check "4b. worker sees 0 message_policies under RLS" \
  $([ "$(jq -r '.[0].p' <<<"$R")" = "0" ]; echo $?)
ERR=$(sql "$(as_user "$WORKER" "select record_approval('$MID','approve');")")
check "4c. worker record_approval refused (does not hold approver role)" \
  $(grep -q 'does not hold the approver role' <<<"$ERR"; echo $?)
ERR=$(sql "$(as_user "$WORKER" "select mark_message_sent('$MID');")")
check "4d. authenticated worker cannot execute internal mark_message_sent" \
  $(grep -qi 'permission denied' <<<"$ERR"; echo $?)
ERR=$(sql "$(as_user "$WORKER" "update outbound_messages set status='approved' where id='$MID';
select count(*) c from outbound_messages where id='$MID' and status='approved';
rollback;")")
check "4e. worker direct table update writes nothing (no insert/update policy)" \
  $([ "$(jq -r '.[0].c' <<<"$ERR")" = "0" ] || grep -qi 'denied\|policy' <<<"$ERR"; echo $?)
A1=$(c "$URL/rest/v1/outbound_messages?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
A2=$(c "$URL/rest/v1/message_policies?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
check "4f. anon blocked from outbound_messages" $([ "$A1" = "0" ]; echo $?)
check "4g. anon blocked from message_policies" $([ "$A2" = "0" ]; echo $?)

# ---------------------------------------------------------------------------
# 5. Automation has zero approval authority (STAKEHOLDERS universal rule 3).
#    Service role carries no JWT, so auth.uid() is null and the RPC raises.
# ---------------------------------------------------------------------------
ERR=$(c -X POST "$URL/rest/v1/rpc/record_approval" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "{\"p_message\":\"$MID\",\"p_decision\":\"approve\"}")
check "5. service-role (no human) approval refused: automation has no authority" \
  $(grep -q 'automation has no approval authority' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 6. `sent` is unreachable without an approval row — three independent paths.
# ---------------------------------------------------------------------------
ERR=$(c -X POST "$URL/rest/v1/rpc/mark_message_sent" "${AUTH[@]}" -d "{\"p_message\":\"$MID\"}")
check "6. authenticated admin cannot execute internal mark_message_sent" \
  $(grep -qi 'permission denied' <<<"$ERR"; echo $?)
ERR=$(sql "update outbound_messages set status='sent' where id='$MID'")
check "6b. direct draft→sent transition refused (transition guard)" \
  $(grep -q 'illegal outbound_messages transition' <<<"$ERR"; echo $?)
ERR=$(sql "insert into outbound_messages (org_id, message_type, draft_key, to_addrs, status, is_fixture)
           values ('$ORG','missing_info_request','fixture:slice4-$RUN-forge',
                   array['customer@example.invalid']::text[],'sent',true)")
check "6c. forged sent row without approval refused (check constraint)" \
  $(grep -q 'outbound_sent_requires_approval\|violates check constraint' <<<"$ERR"; echo $?)
N=$(sql "select count(*) c from outbound_messages
          where status='sent' and (approved_by is null or approved_at is null
                                   or sent_at is null or sent_marked_by is null)" | jq -r '.[0].c')
check "6d. invariant: zero sent rows anywhere lack a full approval record" $([ "$N" = "0" ]; echo $?)

# ---------------------------------------------------------------------------
# 7. The approval path itself: approve → message.approved.
# ---------------------------------------------------------------------------
R=$(c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" -d "{\"p_message\":\"$MID\",\"p_decision\":\"approve\"}")
ROW=$(sql "select status, approved_by, approved_at from outbound_messages where id='$MID'")
check "7. admin approve succeeded → status=approved, approver + time recorded" \
  $([ "$(jq -r '.[0].status' <<<"$ROW")" = "approved" ] \
    && [ "$(jq -r '.[0].approved_by' <<<"$ROW")" = "$ADMIN_ID" ] \
    && [ "$(jq -r '.[0].approved_at' <<<"$ROW")" != "null" ]; echo $?)
EV=$(sql "select count(*) c, max(payload->>'approved_by') ab from integration_events
           where event_type='message.approved' and entity_id='$MID'")
check "7b. message.approved event emitted once, carrying approved_by" \
  $([ "$(jq -r '.[0].c' <<<"$EV")" = "1" ] && [ "$(jq -r '.[0].ab' <<<"$EV")" = "$ADMIN_ID" ]; echo $?)

# Content is frozen once a human has acted on it (you approve what you read).
ERR=$(sql "update outbound_messages set body_text='tampered after approval' where id='$MID'")
check "7c. content frozen after leaving draft" \
  $(grep -q 'frozen once it leaves draft' <<<"$ERR"; echo $?)
# Re-deciding a decided message is refused.
ERR=$(c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" -d "{\"p_message\":\"$MID\",\"p_decision\":\"approve\"}")
check "7d. re-approving a non-draft refused (only a draft can be decided)" \
  $(grep -q 'only a draft can be decided' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 8. Manual send bookkeeping: approved → sent, with manual_send evidence.
# ---------------------------------------------------------------------------
R=$(sql "$(as_service_user "$ADMIN_ID" "select mark_message_sent('$MID');")")
ROW=$(sql "select status, sent_at, sent_marked_by from outbound_messages where id='$MID'")
check "8. approved message marked sent through internal service path → status=sent" \
  $([ "$(jq -r '.[0].status' <<<"$ROW")" = "sent" ] \
    && [ "$(jq -r '.[0].sent_at' <<<"$ROW")" != "null" ] \
    && [ "$(jq -r '.[0].sent_marked_by' <<<"$ROW")" = "$ADMIN_ID" ]; echo $?)
EV=$(sql "select count(*) c, max(payload->>'manual_send') ms from integration_events
           where event_type='message.sent' and entity_id='$MID'")
check "8b. message.sent event emitted once, flagged manual_send" \
  $([ "$(jq -r '.[0].c' <<<"$EV")" = "1" ] && [ "$(jq -r '.[0].ms' <<<"$EV")" = "true" ]; echo $?)
ERR=$(sql "update outbound_messages set status='approved' where id='$MID'")
check "8c. sent is terminal (sent→approved refused)" \
  $(grep -q 'illegal outbound_messages transition' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 9. Rejection requires a reason and is terminal.
# ---------------------------------------------------------------------------
RID=$(sql "select create_outbound_draft('$ORG','$WR','completion_notice',
             'fixture:slice4-$RUN-reject','Work complete','Body',
             array['customer@example.invalid']::text[], null, '{}'::business_role[], true) id" | jq -r '.[0].id')
ERR=$(c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" -d "{\"p_message\":\"$RID\",\"p_decision\":\"reject\"}")
check "9. rejection without a reason refused" $(grep -q 'rejection must record a reason' <<<"$ERR"; echo $?)
c -X POST "$URL/rest/v1/rpc/record_approval" "${AUTH[@]}" \
  -d "{\"p_message\":\"$RID\",\"p_decision\":\"reject\",\"p_reason\":\"wrong customer\"}" >/dev/null
ROW=$(sql "select status, rejection_reason from outbound_messages where id='$RID'")
check "9b. rejection with a reason recorded" \
  $([ "$(jq -r '.[0].status' <<<"$ROW")" = "rejected" ] \
    && [ "$(jq -r '.[0].rejection_reason' <<<"$ROW")" = "wrong customer" ]; echo $?)
N=$(sql "select count(*) c from integration_events where event_type='message.rejected' and entity_id='$RID'" | jq -r '.[0].c')
check "9c. message.rejected event emitted once" $([ "$N" = "1" ]; echo $?)
ERR=$(sql "update outbound_messages set status='approved' where id='$RID'")
check "9d. rejected is terminal (rejected→approved refused)" \
  $(grep -q 'illegal outbound_messages transition' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 10. Final invoice may NEVER be auto (REQUIREMENTS matrix, locked decision).
# ---------------------------------------------------------------------------
ERR=$(sql "update message_policies set mode='auto', approval_limit_cents=100000, approver_role='owner'
            where org_id='$ORG' and message_type='final_invoice'")
check "10. final_invoice refuses mode=auto (message_policies_invoice_never_auto)" \
  $(grep -q 'message_policies_invoice_never_auto' <<<"$ERR"; echo $?)
M=$(sql "select mode from message_policies where org_id='$ORG' and message_type='final_invoice'" | jq -r '.[0].mode')
check "10b. final_invoice still mode=draft after the refused update" $([ "$M" = "draft" ]; echo $?)
# Auto without a spend ceiling or an accountable approver is unbounded authority.
ERR=$(sql "update message_policies set mode='auto' where org_id='$ORG' and message_type='completion_notice'")
check "10c. mode=auto without an approval limit refused" \
  $(grep -q 'message_policies_auto_requires_limit' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 11. draft→auto graduation needs no code change (acceptance criterion 1).
#     Done in an uncommitted transaction: the live seed must stay all-draft.
# ---------------------------------------------------------------------------
R=$(sql "begin;
update message_policies set mode='auto', approval_limit_cents=50000
 where org_id='$ORG' and message_type='completion_notice';
select (select mode from message_policies where org_id='$ORG' and message_type='completion_notice') stored,
       route_outbound('$ORG','completion_notice',null,'{}'::business_role[])->>'policy_mode' pm,
       route_outbound('$ORG','completion_notice',null,'{}'::business_role[])->>'effective_mode' em;
rollback;")
check "11. policy flips draft→auto by data alone (no code change)" \
  $([ "$(jq -r '.[0].stored' <<<"$R")" = "auto" ]; echo $?)
check "11b. flipped row still routes effective_mode=draft (zero v1 auto-sends)" \
  $([ "$(jq -r '.[0].pm' <<<"$R")" = "auto" ] && [ "$(jq -r '.[0].em' <<<"$R")" = "draft" ]; echo $?)
M=$(sql "select count(*) c from message_policies where org_id='$ORG' and mode='auto'" | jq -r '.[0].c')
check "11c. live matrix unchanged: zero rows in auto mode" $([ "$M" = "0" ]; echo $?)

# ---------------------------------------------------------------------------
# 12. No hard deletes (universal rule 1), even for service role.
# ---------------------------------------------------------------------------
ERR=$(sql "delete from outbound_messages where id='$RID'")
check "12. outbound_messages hard delete refused" $(grep -q 'append-only' <<<"$ERR"; echo $?)
ERR=$(sql "delete from message_policies where org_id='$ORG' and message_type='completion_notice'")
check "12b. message_policies hard delete refused" $(grep -q 'append-only' <<<"$ERR"; echo $?)
# approval_drafts is empty on a fresh DB, and a BEFORE DELETE guard that deletes
# zero rows never fires — so seed a row first, or this check proves nothing.
sql "insert into approval_drafts (org_id, category, draft_key, to_addrs, subject, body_text, is_fixture)
     values ('$ORG','service_call_confirmation','fixture:slice4-$RUN-adr',
             array['customer@example.invalid']::text[],'Slice 4 ADR probe','Body', true)
     on conflict do nothing;" >/dev/null
N=$(sql "select count(*) c from approval_drafts where org_id='$ORG' and draft_key='fixture:slice4-$RUN-adr'" | jq -r '.[0].c')
ERR=$(sql "delete from approval_drafts where org_id='$ORG' and draft_key='fixture:slice4-$RUN-adr'")
check "12c. approval_drafts (0014) hard delete refused (non-vacuous: 1 row targeted)" \
  $([ "$N" = "1" ] && grep -q 'append-only' <<<"$ERR"; echo $?)

# ---------------------------------------------------------------------------
# 13. 0014 landed and is usable (it was applied in the same gate as 0015).
# ---------------------------------------------------------------------------
R=$(sql "select count(*) c from information_schema.tables where table_schema='public'
          and table_name in ('approval_drafts','approval_outcomes','category_authority')" | jq -r '.[0].c')
check "13. 0014 tables present live" $([ "$R" = "3" ]; echo $?)
R=$(sql "select count(*) c from category_authority where authority_level <> 'draft_only'" | jq -r '.[0].c')
check "13b. no category has graduated past draft_only (human-set only)" $([ "$R" = "0" ]; echo $?)

# ---------------------------------------------------------------------------
# 14. Live SQL/JS routing parity — retires the dual-implementation risk.
#     Every (type × amount × unavailable-role) case routed by BOTH the live
#     route_outbound() and the offline engine over the same live policy rows.
# ---------------------------------------------------------------------------
PARITY=$(sql "with pol as (select * from message_policies where org_id='$ORG'),
     amt(a) as (values (null::bigint),(0::bigint),(50000::bigint),(999999999::bigint)),
     un(u) as (values ('{}'::business_role[]),
                      (array['office_admin']::business_role[]),
                      (array['owner']::business_role[]),
                      (array['office_admin','owner']::business_role[])),
     cases as (
       select p.message_type, amt.a as amount_cents, un.u as unavailable_roles,
              route_outbound('$ORG', p.message_type, amt.a, un.u) as db
         from pol p cross join amt cross join un)
select jsonb_build_object(
         'policies', (select jsonb_agg(to_jsonb(p)) from pol p),
         'cases', (select jsonb_agg(jsonb_build_object(
                            'message_type', message_type,
                            'amount_cents', amount_cents,
                            'unavailable_roles', to_jsonb(unavailable_roles),
                            'db', db)) from cases)) payload")
PARITY_OUT=$(jq -r '.[0].payload' <<<"$PARITY" | node scripts/parity-route-live.mjs 2>&1)
PARITY_RC=$?
echo "$PARITY_OUT" | sed 's/^/      /'
check "14. live SQL route_outbound() == offline JS route() on every case" $PARITY_RC

# 14b. The v1 matrix has every approval_limit_cents NULL (boss §3 unanswered), so
# the pass above never reaches the limit/escalation branches — a `>` vs `>=` bug
# in either implementation would go unseen. Route the same matrix again with
# limits and backup/escalation roles CONFIGURED, inside an uncommitted
# transaction, so those branches are compared too. Nothing is committed: the live
# matrix stays fail-closed.
PARITY2=$(sql "begin;
update message_policies
   set approval_limit_cents = 50000,
       backup_approver_role = 'owner',
       escalation_role      = 'owner',
       approver_role        = coalesce(approver_role, 'office_admin')
 where org_id='$ORG';
with pol as (select * from message_policies where org_id='$ORG'),
     amt(a) as (values (null::bigint),(0::bigint),(49999::bigint),(50000::bigint),
                       (50001::bigint),(999999999::bigint)),
     un(u) as (values ('{}'::business_role[]),
                      (array['office_admin']::business_role[]),
                      (array['owner']::business_role[]),
                      (array['office_admin','owner']::business_role[]),
                      (array['dispatcher']::business_role[])),
     cases as (
       select p.message_type, amt.a as amount_cents, un.u as unavailable_roles,
              route_outbound('$ORG', p.message_type, amt.a, un.u) as db
         from pol p cross join amt cross join un)
select jsonb_build_object(
         'policies', (select jsonb_agg(to_jsonb(p)) from pol p),
         'cases', (select jsonb_agg(jsonb_build_object(
                            'message_type', message_type,
                            'amount_cents', amount_cents,
                            'unavailable_roles', to_jsonb(unavailable_roles),
                            'db', db)) from cases)) payload;
rollback;")
PARITY2_OUT=$(jq -r '.[0].payload' <<<"$PARITY2" | node scripts/parity-route-live.mjs 2>&1)
PARITY2_RC=$?
echo "$PARITY2_OUT" | sed 's/^/      /'
check "14b. parity holds on a fully-configured matrix (limit + backup + escalation branches)" $PARITY2_RC
# Boundary coverage is the whole point of 14b — assert the escalation branch was
# actually exercised, so the check can never pass vacuously.
ESC=$(jq -r '.[0].payload' <<<"$PARITY2" | jq '[.cases[] | select(.db.escalated == true)] | length')
BAK=$(jq -r '.[0].payload' <<<"$PARITY2" | jq '[.cases[] | select(.db.routing_path == "backup")] | length')
check "14c. 14b exercised the escalation + backup branches (esc=$ESC backup=$BAK)" \
  $([ "$ESC" -gt 0 ] && [ "$BAK" -gt 0 ]; echo $?)
M=$(sql "select count(*) c from message_policies where org_id='$ORG' and approval_limit_cents is not null" | jq -r '.[0].c')
check "14d. live matrix still has zero configured approval limits (fail-closed)" $([ "$M" = "0" ]; echo $?)

# ---------------------------------------------------------------------------
# 15. No-send invariant: nothing in this suite could have transmitted anything.
# ---------------------------------------------------------------------------
N=$(sql "select count(*) c from outbound_messages
          where org_id='$ORG' and exists (
            select 1 from unnest(to_addrs || cc_addrs || bcc_addrs) addr
             where addr not like '%@example.invalid')" | jq -r '.[0].c')
check "15. every outbound recipient live is @example.invalid (no real address)" $([ "$N" = "0" ]; echo $?)
N=$(sql "select count(*) c from outbound_messages where graph_message_id is not null" | jq -r '.[0].c')
check "15b. no graph_message_id exists anywhere (no Graph path in v1)" $([ "$N" = "0" ]; echo $?)

echo; echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
