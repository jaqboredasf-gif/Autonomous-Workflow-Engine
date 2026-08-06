#!/usr/bin/env bash
# Purchasing DOMAIN unit tests (docs/testing/PURCHASING.md).
#
# The fast gate: no database, no filesystem, no clock, no app. It imports only
# apps/purchasing/src/purchasing/domain/** and asserts the invariants — the six
# distinct quantities, one job per request, the frozen original, the closed
# transition graph and its preconditions, the authorization decisions, the
# draft-only email gate, and the exact arithmetic.
#
# Run this while you work; run scripts/eval-purchasing.sh before you push.
#
# Usage: bash scripts/eval-purchasing-domain.sh
set -u
cd "$(dirname "$0")/.."

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-purchasing-domain.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Purchasing domain eval: PASS"
else
  echo "Purchasing domain eval: FAIL (exit $rc)"
fi
exit "$rc"
