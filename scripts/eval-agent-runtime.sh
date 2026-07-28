#!/usr/bin/env bash
# Runner A — bounded provider-neutral Agent Runtime.
# Offline by construction: fixture model/tool adapters, virtual time, no keys,
# network, DB, production configuration, migrations or published workflows.
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-agent-runtime.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner A: PASS"
else
  echo "Runner A: FAIL (exit $rc)"
fi
exit "$rc"
