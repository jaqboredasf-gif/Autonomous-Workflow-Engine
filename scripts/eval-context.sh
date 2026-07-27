#!/usr/bin/env bash
# Runner C — context primitives (assembly, compaction, checkpoints).
#
# PURE by construction: no API keys, no model calls, no database, no network, no
# Microsoft Graph, no mailbox, no n8n, no browser, no filesystem writes. It
# exercises the provider-neutral context subsystem in packages/awe-kernel:
# context items and their tenant/trust/sensitivity labels, deterministic
# assembly with full exclusion accounting, the six deterministic compaction
# mechanisms and their ledger, resumable checkpoints, and the runWorkflow
# integration that keeps every existing context-free runner working unchanged.
#
# Usage: bash scripts/eval-context.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-context.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner C: PASS"
else
  echo "Runner C: FAIL (exit $rc)"
fi
exit "$rc"
