#!/usr/bin/env bash
# Tenant isolation (docs/testing/PURCHASING.md).
#
# Static analysis over the migrations plus behavioural cross-tenant tests
# through the application. It does NOT itself prove row level security:
# Postgres enforces that and is not running in this process.
#
# The live proof is supabase/tests/tenant_isolation.sql, run by
# scripts/verify-supabase-live.sh. It HAS been executed against local Postgres
# and passes, with a negative control that reports leaks when RLS is disabled.
# It has NOT been run against a hosted project, because none is configured.
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
  echo "Tenant isolation: PASS (static + application)"
  echo "  RLS on local Postgres:   PROVEN (scripts/verify-supabase-live.sh)"
  echo "  RLS on a hosted project: NOT PROVEN (none configured or touched)"
else
  echo "Tenant isolation: FAIL (exit $rc)"
fi
exit "$rc"
