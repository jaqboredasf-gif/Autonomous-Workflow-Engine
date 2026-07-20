#!/usr/bin/env bash
# Runner 2A — DETERMINISTIC classification eval (task B2, docs/testing/EVAL_STRATEGY.md).
# No model API key, no network to any model provider: the classifier runs with the
# recorded fixture adapter (fixtures/emails/model_recorded.json) so the harness,
# budget/union/fail-closed logic, real persistence and the deterministic Verify Step
# are all exercised end-to-end against the LIVE Supabase project. Safe in regression
# (idempotent write-back keyed on a deterministic fixture graph_message_id).
#
# The paid, non-deterministic accuracy eval over the real model is Runner 2B
# (scripts/eval-classification-live.sh) — NOT run here and NOT in regression.
#
# Usage: source .env.acceptance && bash scripts/eval-classification.sh
set -u
cd "$(dirname "$0")/.."

LABELS="${LABELS:-fixtures/emails/labels.json}"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"

ALLOWED='emergency service_call estimate_job out_of_territory not_a_work_request unknown'

pass=0; fail=0
ok()   { pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }
check(){ if [ "$2" = "0" ]; then ok; else bad "$1"; fi; }

# --- Hallucination-checker self-test: proves the guard flags an invented value.
st=$(node scripts/classify.mjs --selftest 2>/dev/null)
check "hallucination self-test (invented value must be flagged)" \
  $([ "$st" = "selftest-ok" ]; echo $?)

detect_hits=0; emerg_expected=0; emerg_hits=0; class_hits=0
verify_total=0; verify_ok=0; halluc_total=0

for f in $(jq -r 'keys[] | select(startswith("_") | not)' "$LABELS"); do
  lbl_class=$(jq -r --arg f "$f" '.[$f].classification' "$LABELS")
  lbl_emerg=$(jq -r --arg f "$f" '.[$f].emergency' "$LABELS")

  out=$(node scripts/classify.mjs --fixture "fixtures/emails/$f" --adapter fixture --persist 2>/tmp/b2_err.$$)
  if [ -z "$out" ] || ! jq -e . >/dev/null 2>&1 <<<"$out"; then
    bad "$f runner produced no valid JSON"; cat /tmp/b2_err.$$ >&2; continue
  fi

  cls=$(jq -r '.classification' <<<"$out")
  sts=$(jq -r '.status' <<<"$out")
  emg=$(jq -r '.emergency' <<<"$out")
  vok=$(jq -r '.verify.ok' <<<"$out")
  org=$(jq -r '.verify.checks.org_scoped' <<<"$out")
  evt=$(jq -r '.verify.checks.event_present' <<<"$out")
  dup=$(jq -r '.verify.checks.no_duplicate_side_effect' <<<"$out")
  nh=$(jq -r '.hallucinated_fields | length' <<<"$out")

  # allowed enum value
  echo "$ALLOWED" | grep -qw "$cls"; check "$f classification '$cls' not in allowed enum" $?

  # work-request detection (is / isn't a work request) — HARD 12/12
  got_wr=$([ "$cls" != "not_a_work_request" ] && echo yes || echo no)
  exp_wr=$([ "$lbl_class" != "not_a_work_request" ] && echo yes || echo no)
  [ "$got_wr" = "$exp_wr" ] && detect_hits=$((detect_hits+1)) || bad "$f detection: expected is_work_request=$exp_wr got $got_wr"

  # emergency union recall — HARD 100% on labelled emergencies
  if [ "$lbl_emerg" = "true" ]; then
    emerg_expected=$((emerg_expected+1))
    if [ "$emg" = "true" ]; then emerg_hits=$((emerg_hits+1)); else bad "$f emergency MISSED by union (recall breach)"; fi
  fi

  # fail-closed: fixture 11 (empty/attachment-only) must land unknown + needs_review
  if [ "$f" = "11_attachment_only.json" ]; then
    check "$f fail-closed: expected classification=unknown got $cls" $([ "$cls" = "unknown" ]; echo $?)
    check "$f fail-closed: expected status=needs_review got $sts" $([ "$sts" = "needs_review" ]; echo $?)
  fi

  # hallucinated fields — HARD 0
  halluc_total=$((halluc_total + nh))

  # verify step — HARD 100%
  verify_total=$((verify_total+1))
  if [ "$vok" = "true" ] && [ "$org" = "true" ] && [ "$evt" = "true" ] && [ "$dup" = "true" ]; then
    verify_ok=$((verify_ok+1))
  else
    bad "$f verify step failed (ok=$vok org=$org event=$evt no_dup=$dup)"
  fi

  # classification accuracy vs labels (SOFT >=10/12)
  [ "$cls" = "$lbl_class" ] && class_hits=$((class_hits+1))
done
rm -f /tmp/b2_err.$$

echo "--- Runner 2A gates ---"
check "work-request detection $detect_hits/12 (need 12)"                 $([ "$detect_hits" = "12" ]; echo $?)
check "emergency union recall $emerg_hits/$emerg_expected (need 100%)"   $([ "$emerg_hits" = "$emerg_expected" ] && [ "$emerg_expected" -gt 0 ]; echo $?)
check "hallucinated fields $halluc_total (need 0)"                       $([ "$halluc_total" = "0" ]; echo $?)
check "verify-step pass $verify_ok/$verify_total (need 100%)"            $([ "$verify_ok" = "$verify_total" ] && [ "$verify_total" -gt 0 ]; echo $?)
# soft gate — report, don't fail the build below 12 but fail below 10
check "classification accuracy $class_hits/12 (soft floor 10)"          $([ "$class_hits" -ge 10 ]; echo $?)

echo "eval-classification (Runner 2A, deterministic): passed=$pass failed=$fail  [accuracy $class_hits/12]"
[ "$fail" = "0" ]
