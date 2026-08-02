#!/usr/bin/env bash
# Runner CC — Context Compiler suite (scripts/lib/context-compiler/).
# Pure deterministic: no credentials, DB, network, provider, clock or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-context-compiler.mjs
