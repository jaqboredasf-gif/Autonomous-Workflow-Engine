#!/usr/bin/env bash
# Startup refusal tests — does a misconfigured PRODUCTION start refuse, and does
# it refuse before writing anything?
#
# See scripts/eval-startup-refusal.mjs for what each case is protecting against.
# The short version: the dangerous failure is not PCC stopping, it is PCC
# carrying on against a database nobody meant to create.
#
# The build is part of the gate — these cases run the packaged standalone
# server, which is what systemd and Docker actually start.
#
# Usage: bash scripts/eval-startup-refusal.sh
set -u
cd "$(dirname "$0")/.."

echo "Building for production…"
if ! npm run build -w purchasing >/tmp/pcc-refusal-build.log 2>&1; then
  echo "Startup refusal: FAIL (production build failed)"
  tail -30 /tmp/pcc-refusal-build.log
  exit 1
fi
echo "Build OK."

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-startup-refusal.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Startup refusal: PASS — every misconfigured start refuses, and none of them writes."
else
  echo "Startup refusal: FAIL (exit $rc)"
fi
exit "$rc"
