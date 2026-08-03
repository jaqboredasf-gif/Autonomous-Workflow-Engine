#!/usr/bin/env bash
#
# Read one completed TEGG site visit end to end and write a reviewable page.
#
#   ./scripts/visit-findings.sh                 # the standing selection rule
#   ./scripts/visit-findings.sh T25-204         # a visit you name
#
# Read-only. It signs in, reads, and stops. It never submits a form, approves
# anything, sends an email, uploads a file, or changes a TEGG record.
#
# Credentials come from TEGG_USERNAME and TEGG_PASSWORD in your terminal. They
# are never written to disk and never printed.

set -euo pipefail

# Run from the installation whatever directory you were standing in. Every
# path this tool uses is anchored to here, and a run started elsewhere would
# write customer documents somewhere you did not intend.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="$ROOT/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
    echo "No virtual environment at $ROOT/.venv" >&2
    echo "Set one up first -- see docs/OPERATOR_RUNBOOK.md, 'Installation'." >&2
    exit 1
fi

ARGS=()
if [ $# -gt 0 ]; then
    ARGS+=(--site-visit "$1")
    shift
fi

# A real rate card, if somebody has supplied one. Otherwise the placeholder,
# and every total comes out stamped NOT PRICED.
if [ -f "$ROOT/config/estimating.yaml" ]; then
    ARGS+=(--rate-card config/estimating.yaml)
fi

"$PYTHON" -m awe_tegg run visit-findings "${ARGS[@]}" "$@"
CODE=$?

echo
case $CODE in
    0) echo "Done. The page to read is the 'review' line above." ;;
    2) echo "Stopped and needs a person -- read 'human action required' above." ;;
    *) echo "Could not continue. Nothing was changed in TEGG." ;;
esac
exit $CODE
