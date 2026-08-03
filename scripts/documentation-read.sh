#!/usr/bin/env bash
#
# Read the TEGG Documentation area and list the completed site visits.
# Read-only: this script signs in, reads, and stops. It submits nothing.
#
#   ./scripts/documentation-read.sh
#   ./scripts/documentation-read.sh --headed        # watch the browser work
#
# Credentials come from the environment and are never written down:
#
#   export TEGG_USERNAME='...'      # type this, do not put it in a file
#   export TEGG_PASSWORD='...'
#
# See docs/RUNBOOK.documentation-read.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# Never echo the values. Only whether they are set.
missing=()
[[ -n "${TEGG_USERNAME:-}" ]] || missing+=("TEGG_USERNAME")
[[ -n "${TEGG_PASSWORD:-}" ]] || missing+=("TEGG_PASSWORD")
if (( ${#missing[@]} )); then
  echo "Not set: ${missing[*]}" >&2
  echo "" >&2
  echo "Set them in this terminal, then run this again:" >&2
  echo "  export TEGG_USERNAME='your portal username'" >&2
  echo "  export TEGG_PASSWORD='your portal password'" >&2
  echo "" >&2
  echo "They are used to sign in and are never saved to disk." >&2
  exit 2
fi

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  if [[ -x "$HERE/.venv/bin/python" ]]; then
    PYTHON="$HERE/.venv/bin/python"
  else
    PYTHON="$(command -v python3)"
  fi
fi

exec "$PYTHON" -m awe_tegg run documentation-read \
   "$@"
