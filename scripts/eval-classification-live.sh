#!/usr/bin/env bash
# Runner 2B — LIVE classification eval (task B2, docs/testing/EVAL_STRATEGY.md).
# Real Anthropic inference through the same domain service Runner 2A exercises,
# only the model adapter differs. This is the ONLY runner that measures actual
# classification quality; 2A proves the machine, 2B proves the model.
#
# NOT in regression.sh: nondeterministic + costs money. On-demand at B2
# acceptance and after any prompt/model/taxonomy change.
#
# Requires ANTHROPIC_API_KEY. Exits with a clear setup error (nonzero) when the
# key is absent — a skipped live eval is NOT a passing live eval. Never fakes a
# result. External email sending stays disabled (this only reads the model API).
#
# Usage: source .env.acceptance && ANTHROPIC_API_KEY=... bash scripts/eval-classification-live.sh
set -u
cd "$(dirname "$0")/.."

LABELS="${LABELS:-fixtures/emails/labels.json}"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (management token) first}"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SETUP ERROR: ANTHROPIC_API_KEY is not set."
  echo "Runner 2B runs real, paid model inference and cannot proceed without it."
  echo "This is an external execution dependency, not a pass. B2 stays"
  echo "'implementation complete / deterministic eval green / live eval pending'."
  echo "Deterministic coverage (no key): bash scripts/eval-classification.sh"
  exit 3
fi

MODEL="${AWE_MODEL:-claude-fable-5}"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }

detect_hits=0; emerg_expected=0; emerg_hits=0; class_hits=0
fp=0; fn=0; halluc_total=0; verify_ok=0; verify_total=0
tot_in=0; tot_out=0; tot_ms=0; tot_calls=0

printf '%-34s %-18s %-18s %-7s %s\n' fixture expected got emerg verify
for f in $(jq -r 'keys[] | select(startswith("_") | not)' "$LABELS"); do
  lbl_class=$(jq -r --arg f "$f" '.[$f].classification' "$LABELS")
  lbl_emerg=$(jq -r --arg f "$f" '.[$f].emergency' "$LABELS")

  out=$(AWE_MODEL="$MODEL" node scripts/classify.mjs --fixture "fixtures/emails/$f" \
        --adapter live --persist 2>/tmp/b2live_err.$$)
  if [ -z "$out" ] || ! jq -e . >/dev/null 2>&1 <<<"$out"; then
    bad "$f produced no valid JSON"; cat /tmp/b2live_err.$$ >&2; continue
  fi

  cls=$(jq -r '.classification' <<<"$out")
  emg=$(jq -r '.emergency' <<<"$out")
  vok=$(jq -r '.verify.ok' <<<"$out")
  nh=$(jq -r '.hallucinated_fields | length' <<<"$out")
  tot_in=$((tot_in + $(jq -r '.telemetry.input_tokens' <<<"$out")))
  tot_out=$((tot_out + $(jq -r '.telemetry.output_tokens' <<<"$out")))
  tot_ms=$((tot_ms + $(jq -r '.telemetry.latency_ms' <<<"$out")))
  tot_calls=$((tot_calls + $(jq -r '.telemetry.calls' <<<"$out")))

  printf '%-34s %-18s %-18s %-7s %s\n' "$f" "$lbl_class" "$cls" "$emg" "$vok"

  got_wr=$([ "$cls" != "not_a_work_request" ] && echo yes || echo no)
  exp_wr=$([ "$lbl_class" != "not_a_work_request" ] && echo yes || echo no)
  [ "$got_wr" = "$exp_wr" ] && detect_hits=$((detect_hits+1)) || bad "$f detection exp=$exp_wr got=$got_wr"

  if [ "$lbl_emerg" = "true" ]; then
    emerg_expected=$((emerg_expected+1))
    [ "$emg" = "true" ] && emerg_hits=$((emerg_hits+1)) || { bad "$f emergency MISSED (recall breach)"; fn=$((fn+1)); }
  else
    [ "$emg" = "true" ] && fp=$((fp+1))
  fi

  halluc_total=$((halluc_total + nh))
  verify_total=$((verify_total+1)); [ "$vok" = "true" ] && verify_ok=$((verify_ok+1)) || bad "$f verify failed"
  [ "$cls" = "$lbl_class" ] && class_hits=$((class_hits+1))
done
rm -f /tmp/b2live_err.$$

# Cost estimate mirrors model-adapters.mjs PRICING (fable-5: $3/$15 per Mtok).
cost=$(node -e "const {estimateCostUsd}=await import('./scripts/lib/model-adapters.mjs');console.log(estimateCostUsd(process.argv[1],{input_tokens:+process.argv[2],output_tokens:+process.argv[3]}))" "$MODEL" "$tot_in" "$tot_out")

echo "--- Runner 2B (live: $MODEL) ---"
[ "$detect_hits" = "12" ] && ok || bad "work-request detection $detect_hits/12"
{ [ "$emerg_hits" = "$emerg_expected" ] && [ "$emerg_expected" -gt 0 ]; } && ok || bad "emergency recall $emerg_hits/$emerg_expected (need 100%)"
[ "$halluc_total" = "0" ] && ok || bad "hallucinated fields $halluc_total (need 0)"
{ [ "$verify_ok" = "$verify_total" ] && [ "$verify_total" -gt 0 ]; } && ok || bad "verify $verify_ok/$verify_total (need 100%)"
[ "$class_hits" -ge 10 ] && ok || bad "classification accuracy $class_hits/12 (soft floor 10)"

echo "accuracy=$class_hits/12  FP=$fp  FN=$fn  emergency_recall=$emerg_hits/$emerg_expected"
echo "calls=$tot_calls  tokens_in=$tot_in  tokens_out=$tot_out  latency_ms=$tot_ms  est_cost_usd=$cost"
echo "eval-classification-live (Runner 2B): passed=$pass failed=$fail"
[ "$fail" = "0" ]
