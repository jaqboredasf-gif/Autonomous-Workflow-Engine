#!/usr/bin/env bash
# Purchasing Control Center — DETERMINISTIC eval (docs/testing/PURCHASING.md).
#
# PURE OFFLINE by construction: no API keys, no model calls, no Supabase, no
# network, no Microsoft Graph, no mailbox, no browser. It drives the modules the
# app actually ships (Node 24 strips the TypeScript types on import) against a
# throwaway SQLite database in a temp directory, and asserts the intake rules,
# the field firewall, every authorization rule, the quantity algebra, the status
# machine, PO-number uniqueness under eight concurrent worker threads, the
# draft-only email gate, partial receiving, the audit timeline and tenant
# isolation — plus the full §16 demo scenario end to end.
#
# Usage: bash scripts/eval-purchasing.sh
set -u
cd "$(dirname "$0")/.."

run() {
  PURCHASING_TEST_PROVIDER="$1" node \
    --disable-warning=ExperimentalWarning \
    --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
    scripts/eval-purchasing.mjs
}

# Pass 1: the local provider, which resolves in the same tick.
run local
rc=$?

# Pass 2: the SAME assertions through a provider that answers on a later
# macrotask. The local store settles immediately, so a missing `await` is
# invisible in pass 1 and fails loudly here — which is what a remote provider
# will do in production.
if [ "$rc" = "0" ]; then
  echo ""
  echo "Re-running against the deferred provider (async correctness gate)…"
  run deferred
  rc=$?
fi

if [ "$rc" = "0" ]; then
  echo "Purchasing eval: PASS (local + deferred)"
else
  echo "Purchasing eval: FAIL (exit $rc)"
fi
exit "$rc"
