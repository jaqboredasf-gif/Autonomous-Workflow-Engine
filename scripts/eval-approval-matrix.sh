#!/usr/bin/env bash
# Runner 4 — DETERMINISTIC approval-matrix + outbound-draft eval (Task B3,
# docs/testing/APPROVAL_MATRIX.md).
#
# PURE OFFLINE by construction: no API keys, no model calls, no database, no
# network, no Microsoft Graph, no mailbox, no n8n. It runs the offline routing
# engine (scripts/lib/approval-matrix.mjs) and draft generator
# (scripts/lib/outbound-draft.mjs) over the labelled fixtures in
# fixtures/outbound/ and asserts every label, plus determinism, no-send,
# fixture-recipient safety, fail-closed coverage, template coverage, source
# purity, and matrix-seed parity. Safe in regression.
#
# Usage: bash scripts/eval-approval-matrix.sh
set -u
cd "$(dirname "$0")/.."

# The blocked-reason union check imports the queue's .ts module (Node strips the
# types, same as Runner 5); its typeless-package notice is noise, not a result.
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-approval-matrix.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner 4: PASS"
else
  echo "Runner 4: FAIL (exit $rc)"
fi
exit "$rc"
