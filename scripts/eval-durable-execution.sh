#!/usr/bin/env bash
# Runner D — Durable Execution Plane.
# Offline deterministic: no credentials, DB, network, provider or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-durable-execution.mjs
