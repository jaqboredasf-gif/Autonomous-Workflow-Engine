#!/usr/bin/env bash
# Runner EV — evidence collector and diff suite (scripts/lib/evidence/).
# Pure deterministic: no credentials, DB, network, provider, clock or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-evidence.mjs
