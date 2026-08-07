#!/usr/bin/env bash
# Live Supabase verification — the proof static analysis cannot give.
#
# Starts (or reuses) a LOCAL Supabase stack, applies every migration, and runs
# the SQL security suites under real row level security. A local stack is a safe
# disposable environment by definition; this script never touches a linked or
# remote project.
#
# Requires Docker. Usage: bash scripts/verify-supabase-live.sh
set -u
cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running — live verification skipped (not failed)."
  echo "Start Docker Desktop, then re-run."
  exit 2
fi

CLI="npx --yes supabase@2.112.0"
DB=supabase_db_exattime

if ! docker ps --format '{{.Names}}' | grep -q "^${DB}$"; then
  echo "Starting the local stack (applies every migration)…"
  $CLI start >/tmp/purchasing-supabase-start.log 2>&1 || {
    echo "stack failed to start:"; tail -20 /tmp/purchasing-supabase-start.log; exit 1; }
fi

fail=0
for suite in tenant_isolation membership_and_provisioning; do
  echo "--- ${suite} ---"
  out=$(cat "supabase/tests/${suite}.sql" | docker exec -i "$DB" psql -U postgres -d postgres 2>&1)
  echo "$out" | grep -E "NOTICE|WARNING|ERROR" | head -8
  echo "$out" | grep -q "PASS" || fail=1
done

# A suite that cannot fail proves nothing. Disable one policy and require the
# isolation suite to notice.
echo "--- negative control: RLS disabled must be DETECTED ---"
leaks=$(printf 'begin;\nalter table purchase_requests disable row level security;\n' \
  | cat - supabase/tests/tenant_isolation.sql \
  | docker exec -i "$DB" psql -U postgres -d postgres 2>&1 | grep -c "LEAK")
if [ "$leaks" -lt 1 ]; then
  echo "the isolation suite did NOT detect disabled RLS — it proves nothing"; fail=1
else
  echo "detected ${leaks} leak(s) with RLS off, as required"
fi

# The SQL suites prove the DATABASE refuses cross-tenant access. They say
# nothing about the website: an application can be perfectly isolated at the
# database and still resolve the wrong tenant, or hand out a privileged client.
# That proof is scripts/eval-purchasing-supabase-web.sh, which needs a running
# dev server and so is a separate step, named here so it is not forgotten.
echo "--- website against Supabase persistence ---"
echo "  Not run here: it needs a dev server on PURCHASING_PERSISTENCE=supabase."
echo "  1. node scripts/provision-local-tenants.mjs"
echo "  2. start the app with AUTH_PROVIDER=supabase PURCHASING_PERSISTENCE=supabase"
echo "  3. bash scripts/eval-purchasing-supabase-web.sh"

[ "$fail" = "0" ] && echo "Live Supabase verification: PASS" || echo "Live Supabase verification: FAIL"
exit "$fail"
