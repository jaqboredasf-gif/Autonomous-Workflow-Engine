#!/usr/bin/env bash
# Runner OB — Obsidian bridge (projection, conflict detection, navigation pages).
# Pure deterministic: no credentials, DB, network, provider, clock or live effect.
set -euo pipefail
cd "$(dirname "$0")/.."
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-obsidian.mjs
