#!/usr/bin/env bash
# Runner P — the AWE execution control plane.
#
# PURE OFFLINE by construction: no API keys, no model calls, no database, no
# network, no Microsoft Graph, no mailbox, no n8n, no browser, no filesystem
# writes. Every clock is a virtual stepping clock, so timeout and duration
# behaviour is a deterministic assertion rather than a sleep.
#
# It exercises the registry-backed execution path end to end on the synthetic
# invoice-intake reference workflow: manifest validation, registry resolution,
# context validation, deterministic policy evaluation, controlled tool
# invocation, the human approval gate, pause, resume across a cold store,
# denial, compensation, retry, timeout, cancellation, and the refusal of a
# corrupted or self-contradictory run journal.
#
# Usage: bash scripts/eval-control-plane.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-control-plane.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner P: PASS"
else
  echo "Runner P: FAIL (exit $rc)"
fi
exit "$rc"
