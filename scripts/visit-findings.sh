#!/usr/bin/env bash
#
# Read one completed TEGG site visit end to end and write a reviewable page.
#
#   ./scripts/visit-findings.sh                 # the standing selection rule
#   ./scripts/visit-findings.sh T25-204         # a visit you name
#   ./scripts/visit-findings.sh T25-204 --headed
#
# Read-only. It signs in, reads, and stops. It never submits a form, approves
# anything, sends an email, uploads a file, or changes a TEGG record.
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

ARGS=()
# A bare first argument is the site visit. Anything starting with a dash is a
# flag and is passed straight through.
if [[ $# -gt 0 && "$1" != -* ]]; then
    ARGS+=(--site-visit "$1")
    shift
fi

# A real rate card, if somebody has supplied one. Otherwise the placeholder,
# and every total comes out stamped NOT PRICED.
if [[ -f "$ROOT/config/estimating.yaml" ]]; then
    ARGS+=(--rate-card config/estimating.yaml)
fi

# ${ARGS[@]+"${ARGS[@]}"} rather than "${ARGS[@]}": the latter is an
# unbound-variable error under `set -u` on bash 3.2 when the array is empty,
# which is the no-argument path -- the documented default.
awe_run -m awe_tegg run visit-findings ${ARGS[@]+"${ARGS[@]}"} "$@"
