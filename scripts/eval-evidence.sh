#!/usr/bin/env bash
# Runner 6 — DETERMINISTIC evidence-layer eval (evidence/PROTOCOL.md).
#
# PURE OFFLINE by construction: no API keys, no model calls, no database, no
# network, no mailbox, no browser. It imports the same modules the evidence CLI
# ships (scripts/lib/evidence/*.mjs) and asserts the guarantees that make the
# IIC evidence claims defensible:
#
#   * every value carries a confidence class, and "derived" cannot be hand-entered
#   * estimates require a basis and a low/high range and can never pass as documentary
#   * "unknown" is preserved and never coerced to zero
#   * post-AWE work cannot enter a pre-AWE baseline (contamination gates)
#   * a freeze detects edits, deletions, additions and manifest tampering
#   * rehearsal, synthetic and invalid records can NEVER raise IIC readiness
#   * a file merely existing satisfies nothing
#
# Usage: bash scripts/eval-evidence.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-evidence.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner 6: PASS"
else
  echo "Runner 6: FAIL (exit $rc)"
fi
exit "$rc"
