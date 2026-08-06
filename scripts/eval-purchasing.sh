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

node \
  --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  scripts/eval-purchasing.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Purchasing eval: PASS"
else
  echo "Purchasing eval: FAIL (exit $rc)"
fi
exit "$rc"
