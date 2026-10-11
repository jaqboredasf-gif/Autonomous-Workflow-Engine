#!/usr/bin/env bash
# The website, running on Supabase persistence, exercised over HTTP
# (docs/testing/PURCHASING.md).
#
# Unlike every other suite here, this one needs two live things: the local
# Supabase stack and a dev server started with PURCHASING_PERSISTENCE=supabase.
# It refuses to run rather than reporting a pass it did not earn.
#
# Usage:
#   npx supabase start
#   node scripts/provision-local-tenants.mjs          # two tenants, two users
#   PURCHASING_PERSISTENCE=supabase AUTH_PROVIDER=supabase ... npx next dev -p 3100
#   bash scripts/eval-purchasing-supabase-web.sh
set -u
cd "$(dirname "$0")/.."

BASE="${ACCEPTANCE_BASE_URL:-http://localhost:3100}"
SUPA="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:54321}"

if [ -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "Supabase web acceptance: SKIPPED — NEXT_PUBLIC_SUPABASE_ANON_KEY and"
  echo "  SUPABASE_SERVICE_ROLE_KEY must be set (see 'npx supabase status')."
  exit 2
fi

if ! curl -sf -o /dev/null "$SUPA/rest/v1/" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"; then
  echo "Supabase web acceptance: SKIPPED — no Supabase stack at $SUPA."
  exit 2
fi

if ! curl -s -o /dev/null -w '%{http_code}' "$BASE/sign-in" | grep -q '^2'; then
  echo "Supabase web acceptance: SKIPPED — no dev server at $BASE."
  exit 2
fi

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-purchasing-supabase-web.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Supabase web acceptance: PASS"
else
  echo "Supabase web acceptance: FAIL (exit $rc)"
fi
exit "$rc"
