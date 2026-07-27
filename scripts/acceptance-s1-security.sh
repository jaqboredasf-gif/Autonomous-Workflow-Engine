#!/usr/bin/env bash
# Acceptance test — S1: service-role-only tables stay service-role-only.
#
# Covers the security behaviour nothing else in the suite pins:
#   * slice 1 check 5 proves only that ANON cannot read integration_events. The
#     16 undeclared policies target `authenticated`, so anon was never the
#     exposed principal — this script probes a real worker JWT.
#   * slice 5 check 4 only PRINTS the live policy count on integration_events.
#     Nothing asserted it, so the count could drift in either direction unnoticed.
#   * nothing tested time_entry_audits at all, which is where the finding is
#     worst (the owner of an edited entry can read/delete/forge their own audit
#     trail while the policies stand).
#   * the repo<->live policy drift check existed only as a copy-paste recipe in
#     CONTEXT.md. Here it is an assertion.
#
# STATE-AWARE BY DESIGN. Section B adapts to whether the S1 migration has been
# applied, so this file is green before the apply and green after it, and RED on
# any drift away from either known state:
#   * S1 PENDING  (16 policies) -> asserts the exposure is exactly as documented
#   * S1 APPLIED  ( 0 policies) -> asserts the exposure is closed
# It fails on anything else (17 policies, a new undeclared policy, RLS switched
# off, a definer function that stopped being definer).
#
# WRITES NOTHING. Every write probe runs inside a transaction that is aborted by
# a deliberate exception, so no row, event, crew or audit row can survive. Reads
# through PostgREST use the publishable key only.
#
# Usage: source .env.acceptance && bash scripts/acceptance-s1-security.sh
set -u
cd "$(dirname "$0")/.."

URL="https://qgoiacwdntaqeghcyjlw.supabase.co"
ANON="sb_publishable_EDVoHYrGox6sA1CVE3hIBg_vlIRzvHT"
MGMT="https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"

ORG="2b219aa5-1148-4e3e-a1a0-1725d62b935c"
WORKER="f1000000-0000-4000-8000-000000000001"          # fixture non-approver, role=worker
AUDITED_USER="22f34395-0e5a-400b-af49-62c2500c7da7"    # owner of the one audited entry
TABLES="'integration_events','time_entry_audits','crews','crew_members'"

pass=0; fail=0
check() { if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi }

# Management API with backoff on throttle only (same contract as slices 4/5).
sql() {
  local out
  for attempt in 1 2 3 4 5 6; do
    out=$(jq -Rs '{query: .}' <<<"$1" | curl -s --retry 2 --retry-all-errors -X POST "$MGMT" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-)
    if grep -q 'ThrottlerException\|Too Many Requests' <<<"$out"; then sleep $((attempt * 8)); continue; fi
    break
  done
  printf '%s' "$out"
}

echo "--- S1 security acceptance (org $ORG) ---"

# ---------------------------------------------------------------------------
# A. INVARIANTS — must hold whether or not S1 has been applied.
# ---------------------------------------------------------------------------

# A1: every live policy in `public` is either declared by a migration in this
# repo or is one of the 16 known orphan policies. Anything else is new drift.
LIVE=$(sql "select policyname, tablename from pg_policies where schemaname='public' order by 1")
UNKNOWN=""
while IFS=$'\t' read -r p t; do
  [ -z "$p" ] && continue
  grep -qrE "create policy( if not exists)? +\"?${p}\"?[ (]" supabase/migrations/ && continue
  # not declared — allowed only if it is one of the 16 documented orphans
  grep -qE "^(integration_events|time_entry_audits|crews|crew_members)_org_(select|insert|update|delete)$" <<<"$p" \
    || UNKNOWN="$UNKNOWN $p($t)"
done < <(jq -r '.[] | "\(.policyname)\t\(.tablename)"' <<<"$LIVE")
check "A1. no live policy outside {repo-declared} u {the 16 documented S1 orphans}${UNKNOWN:+ — found:$UNKNOWN}" \
  $([ -z "$UNKNOWN" ]; echo $?)

# A2: RLS is enabled on every public base table (never traded away for a fix).
RLSOFF=$(sql "select string_agg(c.relname, ',') t from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relkind='r' and not c.relrowsecurity" | jq -r '.[0].t // ""')
check "A2. RLS enabled on every public base table${RLSOFF:+ — off on: $RLSOFF}" $([ -z "$RLSOFF" ]; echo $?)

# A3: the definer-bypass precondition still holds on the four tables — owned by
# postgres and NOT force-RLS, which is what lets emit_event()/the audit trigger
# keep writing once the client policies are gone.
OWN=$(sql "select count(*) c from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname in ($TABLES)
             and c.relrowsecurity and not c.relforcerowsecurity and pg_get_userbyid(c.relowner)='postgres'" | jq -r '.[0].c')
check "A3. all 4 tables: RLS on, FORCE off, owned by postgres (definer bypass intact) [$OWN/4]" \
  $([ "$OWN" = "4" ]; echo $?)

# A4: the only functions that touch these tables are SECURITY DEFINER owned by
# postgres. A non-definer writer would break the moment the policies go.
NONDEF=$(sql "select count(*) c from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.prosrc ~* '(integration_events|time_entry_audits|crew_members|\mcrews\M)'
                and not (p.prosecdef and pg_get_userbyid(p.proowner)='postgres')" | jq -r '.[0].c')
check "A4. every function touching the 4 tables is SECURITY DEFINER owned by postgres" \
  $([ "$NONDEF" = "0" ]; echo $?)

# A5: the orphan `ensure_rls` event trigger stays gone — it auto-enabled RLS on
# every DDL command and is the mechanism that produced this drift in the first place.
ETRIG=$(sql "select count(*) c from pg_event_trigger where evtname='ensure_rls'" | jq -r '.[0].c')
check "A5. orphan ensure_rls event trigger absent" $([ "$ETRIG" = "0" ]; echo $?)

# A6: anon is blocked regardless of S1 state (the 16 policies never granted anon;
# this pins that a fix never accidentally opens the logged-out path).
A_EV=$(curl -s --retry 2 --retry-all-errors "$URL/rest/v1/integration_events?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
A_AU=$(curl -s --retry 2 --retry-all-errors "$URL/rest/v1/time_entry_audits?select=id&limit=1" -H "apikey: $ANON" | jq 'length')
check "A6. anon reads 0 integration_events and 0 time_entry_audits" \
  $([ "$A_EV" = "0" ] && [ "$A_AU" = "0" ]; echo $?)

# ---------------------------------------------------------------------------
# B. CLIENT-PATH EXPOSURE — asserted against whichever S1 state is live.
# ---------------------------------------------------------------------------
POLS=$(sql "select count(*) c from pg_policies where schemaname='public' and tablename in ($TABLES)" | jq -r '.[0].c')
if [ "$POLS" = "0" ]; then S1STATE="APPLIED"; elif [ "$POLS" = "16" ]; then S1STATE="PENDING"; else S1STATE="DRIFT"; fi
echo
echo "--- S1 state: $S1STATE ($POLS client policies on the 4 service-role-only tables) ---"
check "B0. policy count on the 4 tables is a known state (0=applied, 16=pending)" \
  $([ "$S1STATE" != "DRIFT" ]; echo $?)

# Read probe as the fixture worker, inside a rolled-back transaction.
READS=$(sql "
begin;
set local role authenticated;
set local request.jwt.claims = '{\"sub\":\"$WORKER\",\"role\":\"authenticated\"}';
select (select count(*) from integration_events) ev,
       (select count(*) from crews) cr,
       (select count(*) from crew_members) cm;
rollback;")
W_EV=$(jq -r '.[0].ev' <<<"$READS"); W_CR=$(jq -r '.[0].cr' <<<"$READS"); W_CM=$(jq -r '.[0].cm' <<<"$READS")

AUD=$(sql "
begin;
set local role authenticated;
set local request.jwt.claims = '{\"sub\":\"$AUDITED_USER\",\"role\":\"authenticated\"}';
select count(*) n from time_entry_audits;
rollback;")
O_AU=$(jq -r '.[0].n' <<<"$AUD")

# Write probes: one aborted transaction, results carried out on the exception.
WRITES=$(sql "
do \$\$
declare forged int := 0; crewed int := 0; audit_forged int := 0;
begin
  perform set_config('request.jwt.claims','{\"sub\":\"$WORKER\",\"role\":\"authenticated\"}', true);
  execute 'set local role authenticated';
  begin
    insert into integration_events (event_type, entity_type, entity_id, org_id, payload)
    values ('S1.PROBE','probe', gen_random_uuid(), '$ORG', '{}'::jsonb);
    get diagnostics forged = row_count;
  exception when insufficient_privilege then forged := 0; end;
  begin
    insert into crews (org_id, name, foreman_id) values ('$ORG','S1 PROBE CREW','$WORKER');
    get diagnostics crewed = row_count;
  exception when insufficient_privilege then crewed := 0; end;
  execute 'reset role';
  perform set_config('request.jwt.claims','{\"sub\":\"$AUDITED_USER\",\"role\":\"authenticated\"}', true);
  execute 'set local role authenticated';
  begin
    insert into time_entry_audits (time_entry_id, edited_by, old_values, new_values)
    select id, null, '{}'::jsonb, '{}'::jsonb from time_entries where status='approved' limit 1;
    get diagnostics audit_forged = row_count;
  exception when insufficient_privilege then audit_forged := 0; end;
  execute 'reset role';
  raise exception 'S1PROBE forged=% crewed=% audit_forged=%', forged, crewed, audit_forged;
end \$\$;")
F_EV=$(grep -o 'forged=[0-9]*' <<<"$WRITES" | head -1 | cut -d= -f2)
F_CR=$(grep -o 'crewed=[0-9]*' <<<"$WRITES" | cut -d= -f2)
F_AU=$(grep -o 'audit_forged=[0-9]*' <<<"$WRITES" | cut -d= -f2)

if [ "$S1STATE" = "APPLIED" ]; then
  check "B1. worker JWT reads 0 integration_events (was the whole event log)" $([ "$W_EV" = "0" ]; echo $?)
  check "B2. worker JWT reads 0 crews / 0 crew_members"  $([ "$W_CR" = "0" ] && [ "$W_CM" = "0" ]; echo $?)
  check "B3. audited user reads 0 of their own audit rows" $([ "$O_AU" = "0" ]; echo $?)
  check "B4. worker cannot forge an integration_event"     $([ "$F_EV" = "0" ]; echo $?)
  check "B5. worker cannot create a crew"                  $([ "$F_CR" = "0" ]; echo $?)
  check "B6. audited user cannot forge an audit row"       $([ "$F_AU" = "0" ]; echo $?)
else
  # S1 PENDING: pin the documented exposure exactly, so this file is a live
  # non-vacuity proof of the finding rather than a test that passes by accident.
  check "B1. [PENDING] worker JWT still reads the event log — finding is real (reads=$W_EV)" \
    $([ "$W_EV" -gt 0 ]; echo $?)
  check "B2. [PENDING] crews/crew_members still empty, so removal loses no data ($W_CR/$W_CM)" \
    $([ "$W_CR" = "0" ] && [ "$W_CM" = "0" ]; echo $?)
  check "B3. [PENDING] audited user still reads their own audit rows (reads=$O_AU)" \
    $([ "$O_AU" -gt 0 ]; echo $?)
  check "B4. [PENDING] worker can still forge an event / crew / audit row ($F_EV/$F_CR/$F_AU)" \
    $([ "$F_EV" = "1" ] && [ "$F_CR" = "1" ] && [ "$F_AU" = "1" ]; echo $?)
  echo "      ^ these PASS because S1 is NOT applied. They invert to closed-access"
  echo "        assertions automatically once the migration lands."
fi

# ---------------------------------------------------------------------------
# C. SURVIVING WRITE PATHS — must work in both states (this is what the drop
#    must not break). Both probes abort, so nothing persists.
# ---------------------------------------------------------------------------
DEF=$(sql "
do \$\$
declare n int;
begin
  perform set_config('request.jwt.claims','{\"sub\":\"$WORKER\",\"role\":\"authenticated\"}', true);
  execute 'set local role authenticated';
  perform emit_event('S1.DEFINER_PROBE','probe', gen_random_uuid(), '$ORG', '{\"probe\":true}'::jsonb);
  execute 'reset role';
  select count(*) into n from integration_events where event_type='S1.DEFINER_PROBE';
  raise exception 'S1DEFINER wrote=%', n;
end \$\$;")
D_N=$(grep -o 'wrote=[0-9]*' <<<"$DEF" | cut -d= -f2)
check "C1. emit_event() still writes when called from an authenticated session" $([ "$D_N" = "1" ]; echo $?)

TRG=$(sql "
do \$\$
declare b int; a int;
begin
  select count(*) into b from time_entry_audits;
  update time_entries set notes = coalesce(notes,'') || ' s1-probe' where status='approved';
  select count(*) into a from time_entry_audits;
  raise exception 'S1TRIGGER delta=%', a - b;
end \$\$;")
T_D=$(grep -o 'delta=[0-9]*' <<<"$TRG" | cut -d= -f2)
check "C2. time_entries_audit trigger still writes exactly 1 audit row per edit (delta=$T_D)" \
  $([ "$T_D" = "1" ]; echo $?)

# ---------------------------------------------------------------------------
# D. NO RESIDUE — every probe above must have left the database untouched.
# ---------------------------------------------------------------------------
RES=$(sql "select (select count(*) from integration_events where event_type like 'S1.%') s1rows,
                  (select count(*) from crews) crews,
                  (select count(*) from crew_members) cm,
                  (select count(*) from time_entries where notes like '%s1-probe%') notes")
check "D1. no probe residue (S1.* events / crews / crew_members / probe notes all 0)" \
  $([ "$(jq -r '.[0].s1rows' <<<"$RES")" = "0" ] \
 && [ "$(jq -r '.[0].crews'  <<<"$RES")" = "0" ] \
 && [ "$(jq -r '.[0].cm'     <<<"$RES")" = "0" ] \
 && [ "$(jq -r '.[0].notes'  <<<"$RES")" = "0" ]; echo $?)

echo; echo "passed=$pass failed=$fail  (S1 state: $S1STATE)"
[ "$fail" = "0" ]
