#!/usr/bin/env bash
# Runner V — context validator unit suite (scripts/lib/context-validator.mjs).
# Pure deterministic: no credentials, DB, network, provider or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-context-validator.mjs
