#!/usr/bin/env bash
# Website acceptance tests (docs/testing/PURCHASING.md).
#
# Builds the application for production, starts it on a spare port against a
# throwaway database, and drives it over real HTTP: middleware, cookies,
# redirects and server components as a browser would meet them.
#
# The build is part of the gate — "the production build passes" is one of the
# things this proves.
#
# Usage: bash scripts/eval-purchasing-web.sh
set -u
cd "$(dirname "$0")/.."

echo "Building for production…"
if ! npm run build -w purchasing >/tmp/purchasing-web-build.log 2>&1; then
  echo "Website acceptance: FAIL (production build failed)"
  tail -30 /tmp/purchasing-web-build.log
  exit 1
fi
echo "Build OK."

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-purchasing-web.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Website acceptance: PASS"
else
  echo "Website acceptance: FAIL (exit $rc)"
fi
exit "$rc"
