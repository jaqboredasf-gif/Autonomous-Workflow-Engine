#!/usr/bin/env bash
# Runner K — awe-kernel unit suite (packages/awe-kernel).
#
# PURE by construction: no API keys, no model calls, no database, no network, no
# Microsoft Graph, no mailbox, no n8n, no browser. It exercises every kernel
# module (canonical form, error taxonomy, blocked-reason registry, outcome
# envelope, audit events, Verify Steps, corpora, gate runs, suite registry),
# asserts the platform's real blocked-reason union loads without a collision,
# and runs the layering lint that keeps the kernel dependency-free, clock-free
# and network-free. Safe in regression; runs first because it gates everything
# built on the kernel.
#
# Usage: bash scripts/eval-kernel.sh
set -u
cd "$(dirname "$0")/.."

# Node's type-stripping notice for the imported .ts module is noise, not a
# result — Runner 5 imports the same file. Keep stderr, drop that one warning.
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-kernel.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner K: PASS"
else
  echo "Runner K: FAIL (exit $rc)"
fi
exit "$rc"
