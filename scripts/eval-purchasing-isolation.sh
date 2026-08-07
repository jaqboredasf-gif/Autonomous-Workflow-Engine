#!/usr/bin/env bash
# Tenant isolation (docs/testing/PURCHASING.md).
#
# Static analysis over the migrations plus behavioural cross-tenant tests
# through the application. It does NOT prove row level security: Postgres
# enforces that and is not running here. The live proof is
# supabase/tests/tenant_isolation.sql.
#
# Usage: bash scripts/eval-purchasing-isolation.sh
set -u
cd "$(dirname "$0")/.."

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-purchasing-isolation.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Tenant isolation: PASS (static + application; RLS still unproven)"
else
  echo "Tenant isolation: FAIL (exit $rc)"
fi
exit "$rc"
