#!/usr/bin/env bash
# Runner CG — cognition registry and handoff ingestion.
# Pure deterministic: no credentials, DB, network, provider, clock or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-cognition.mjs
