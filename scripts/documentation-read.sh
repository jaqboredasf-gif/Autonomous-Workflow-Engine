#!/usr/bin/env bash
#
# List the completed TEGG site visits, and stop.
#
#   ./scripts/documentation-read.sh
#   ./scripts/documentation-read.sh --headed        # watch the browser work
#
# Read-only: it signs in, reads, and stops. It submits nothing.
#
# Credentials come from TEGG_USERNAME and TEGG_PASSWORD in your terminal. They
# are never written to disk and never printed.
#
# See docs/OPERATOR_RUNBOOK.md.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_awe.sh"

ROOT="$(awe_root)"
cd "$ROOT"

if ! AWE_PYTHON="$(awe_python "$ROOT")"; then
    echo "No python found, and no virtual environment at $ROOT/.venv" >&2
    echo "See docs/OPERATOR_RUNBOOK.md, 'Installation'." >&2
    exit 4
fi
export AWE_PYTHON

awe_require_credentials TEGG_USERNAME TEGG_PASSWORD || exit 4

awe_run -m awe_tegg run documentation-read "$@"
