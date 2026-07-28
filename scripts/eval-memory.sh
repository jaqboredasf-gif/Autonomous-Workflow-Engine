#!/usr/bin/env bash
# Runner Y — tenant-bound, versioned and replayable Memory Layer.
# Offline by construction: in-memory records, fixture retrieval adapters,
# injected clocks, no credentials, network, DB, provider SDK or migration.
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-memory.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner Y: PASS"
else
  echo "Runner Y: FAIL (exit $rc)"
fi
exit "$rc"
