#!/usr/bin/env bash
# Runner 3 — DETERMINISTIC approval-diff eval (Task ADR, docs/testing/APPROVAL_DIFF.md).
#
# PURE OFFLINE by construction: no API keys, no model calls, no database, no
# network, no Microsoft Graph, no mailbox. It runs the offline diff engine
# (scripts/lib/approval-diff.mjs) over the labelled fixtures in
# fixtures/approvals/ and asserts every label, plus determinism, contract shape,
# and full edit-class coverage. Safe in regression.
#
# Usage: bash scripts/eval-approval-diff.sh
set -u
cd "$(dirname "$0")/.."

node scripts/eval-approval-diff.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner 3: PASS"
else
  echo "Runner 3: FAIL (exit $rc)"
fi
exit "$rc"
