#!/usr/bin/env bash
# Runner RP — Agent Runtime context port.
# Pure deterministic: no credentials, DB, network, provider, clock or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-runtime-port.mjs
