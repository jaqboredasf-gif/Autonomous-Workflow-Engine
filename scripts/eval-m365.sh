#!/usr/bin/env bash
# Runner 6 — DETERMINISTIC Microsoft 365 Integration Plane eval (Task I1,
# docs/architecture/M365_INTEGRATION_PLANE.md).
#
# PURE OFFLINE by construction: no Microsoft credentials, no admin consent, no
# public webhook endpoint, no network, no database, no model call, no n8n. It
# drives the real integration plane (packages/m365) against the deterministic
# fake Graph provider over the labelled fixtures in fixtures/m365/, and asserts
# every label plus the hard gates: no send path, tenant isolation, resource
# allowlist, least-privilege scopes, approval enforcement, duplicate-delivery
# idempotency, bounded retries, evidence completeness and chain integrity,
# determinism, no fabricated live results, and vocabulary parity with migration
# 0016.
#
# Node strips TypeScript types on import, so the runner tests the SAME modules
# the package ships — not a copy of them.
#
# Usage: bash scripts/eval-m365.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-m365.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner 6: PASS"
else
  echo "Runner 6: FAIL (exit $rc)"
fi
exit "$rc"
