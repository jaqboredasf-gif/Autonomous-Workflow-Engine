#!/usr/bin/env bash
# Runner DP — dispatch lifecycle, handoff contract and verification.
# Pure deterministic: no credentials, DB, network, provider, clock or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-dispatch.mjs
