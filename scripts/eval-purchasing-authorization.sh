#!/usr/bin/env bash
# Authorization (docs/testing/PURCHASING.md).
#
# Coverage that every mutating use case authorizes, the full role x capability
# matrix asserted in both directions, and the specific refusals this business
# depends on. Offline: pure domain functions plus a source scan.
#
# Usage: bash scripts/eval-purchasing-authorization.sh
set -u
cd "$(dirname "$0")/.."

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-purchasing-authorization.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Authorization: PASS"
else
  echo "Authorization: FAIL (exit $rc)"
fi
exit "$rc"
