#!/usr/bin/env bash
# Runner 7 — DETERMINISTIC manual-intake eval (0016 manual intake bridge).
#
# PURE OFFLINE by construction: no API keys, no model calls, no database, no
# network. It imports the module the /requests/new page ships and asserts the
# properties that keep a temporary bridge from becoming a hole in the system:
# only the two genuinely required facts are mandatory, optional fields never
# become empty strings, a customer email is validated because it doubles as a
# reply address downstream, a future received_at is refused, the idempotency key
# survives into the payload, and the page can neither forge a graph_message_id,
# label real data as a fixture, choose its own tenant, nor reach the send path.
#
# Usage: bash scripts/eval-manual-intake.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-manual-intake.mjs
rc=$?
if [ "$rc" = "0" ]; then echo "Runner 7: PASS"; else echo "Runner 7: FAIL (exit $rc)"; fi
exit "$rc"
