#!/usr/bin/env bash
# Runner 5 — DETERMINISTIC approval-queue eval (Task B5,
# docs/testing/APPROVAL_QUEUE.md).
#
# PURE OFFLINE by construction: no API keys, no model calls, no database, no
# network, no Microsoft Graph, no mailbox, no n8n, no browser. It imports the
# queue's decidable logic (apps/web/src/lib/approval-queue.ts) and runs it over
# the labelled fixtures in fixtures/queue/, asserting every label plus
# determinism, duplicate-decision protection, unauthorized-approver denial,
# required rejection reasons, TEST-mode enforcement in both directions, the
# empty/failed-fetch view states, schema/enum parity with migrations 0011/0015,
# and source purity (no send path, no service-role key in the browser).
#
# Node 24 strips TypeScript types on import, so the runner tests the SAME module
# the page ships — not a copy of it.
#
# Usage: bash scripts/eval-approval-queue.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-approval-queue.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner 5: PASS"
else
  echo "Runner 5: FAIL (exit $rc)"
fi
exit "$rc"
