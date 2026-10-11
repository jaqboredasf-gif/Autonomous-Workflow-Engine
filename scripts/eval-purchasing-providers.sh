#!/usr/bin/env bash
# Provider conformance (docs/testing/PURCHASING.md).
#
# Checks the Supabase adapter against the local one WITHOUT credentials: method
# shape and arity, async-ness, exact money/quantity conversion, table names
# against the migrations, explicit tenant scoping, and that the service-role
# client never appears on a read path.
#
# It does NOT prove the adapter works. That needs a real project; see
# docs/PURCHASING_ASYNC_REFACTOR_HANDOFF.md.
#
# Usage: bash scripts/eval-purchasing-providers.sh
set -u
cd "$(dirname "$0")/.."

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-purchasing-providers.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Provider conformance: PASS"
else
  echo "Provider conformance: FAIL (exit $rc)"
fi
exit "$rc"
