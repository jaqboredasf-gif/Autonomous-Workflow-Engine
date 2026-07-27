#!/usr/bin/env bash
# Full automated regression: typechecks, build, MCP smoke, acceptance suites, evals.
#
# The list of suites is NOT in this file. It lives in the suite registry
# (packages/awe-kernel/src/registry.mjs) and is resolved by
# scripts/lib/suite-plan.mjs, which decides order, skips (missing script) and
# the management-API cooldown. This script is the executor: run each planned
# suite, count failures, report. Adding a suite means adding a descriptor to the
# registry — never editing bash.
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=... SUPABASE_SERVICE_ROLE_KEY=... EMAIL=... PASSWORD=... bash scripts/regression.sh
#
# Subsetting (passed straight through to the planner):
#   bash scripts/regression.sh --kinds=unit,offline,static   # everything that needs no credentials
#   bash scripts/regression.sh --only=eval-kernel,eval-approval-diff
#   bash scripts/regression.sh --exclude-kinds=build
#   bash scripts/regression.sh --dry-run                     # print the plan, run nothing
set -u
cd "$(dirname "$0")/.."
fails=0
ran=0
skipped=0

step() { echo; echo "== $1"; }

# --dry-run is ours; every other flag belongs to the planner.
plan_args=()
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    *) plan_args+=("$arg") ;;
  esac
done

if [ "$dry_run" = "1" ]; then
  node scripts/lib/suite-plan.mjs ${plan_args+"${plan_args[@]}"}
  exit 0
fi

# Process substitution (not a pipe) so the counters live in THIS shell.
while IFS=$'\t' read -r id status echo_ok quiet cooldown name command skip_reason; do
  [ -z "${id:-}" ] && continue

  if [ "$status" != "run" ]; then
    skipped=$((skipped+1))
    continue
  fi

  step "$name"
  ran=$((ran+1))

  if [ "$quiet" = "1" ]; then
    # Structural validators are noisy on success; show their output only when
    # they fail, by re-running them.
    if eval "$command" >/dev/null 2>&1; then
      echo OK
    else
      eval "$command"
      fails=$((fails+1))
    fi
  elif eval "$command"; then
    [ "$echo_ok" = "1" ] && echo OK
  else
    [ "$echo_ok" = "1" ] && echo FAIL
    fails=$((fails+1))
  fi

  if [ "${cooldown:-0}" -gt 0 ]; then
    # The management-API window is per minute and the suites that follow are
    # also mgmt-heavy; a 429 there reports as a fake test failure. The runners
    # retry with backoff too (scripts/lib/db.mjs); this avoids paying for it.
    echo "   (mgmt-API cooldown ${cooldown}s before the mgmt-heavy runners)"
    sleep "$cooldown"
  fi
done < <(node scripts/lib/suite-plan.mjs --format=tsv ${plan_args+"${plan_args[@]}"})

echo
echo "regression: $([ $fails = 0 ] && echo ALL GREEN || echo "$fails FAILURES")  [$ran ran, $skipped skipped]"
[ "$fails" = "0" ]
