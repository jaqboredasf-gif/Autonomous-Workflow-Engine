#!/usr/bin/env bash
#
# TEGG Report Tool — check this Mac is ready.
#
# Double-click this any time. It changes nothing: it does not sign in, does not
# contact TEGG unless you ask it to, and does not create any files.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE="$(pwd)"
KEYCHAIN_SERVICE="TEGG Report Tool"

finish() { printf '\n%s\n' "Press Return to close this window."; read -r _ || true; exit "${1:-0}"; }

if [ ! -x "$HERE/.venv/bin/awe-tegg" ]; then
    echo "The tool is not installed on this Mac yet."
    echo "Double-click  Setup.command  first."
    finish 4
fi

TEGG_USERNAME="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a username -w 2>/dev/null || true)" \
TEGG_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a password -w 2>/dev/null || true)" \
    "$HERE/.venv/bin/awe-tegg" doctor --online
CODE=$?

echo ""
if [ $CODE -eq 0 ]; then
    echo "This Mac is ready. Double-click  Run Report.command  to use the tool."
else
    echo "Something needs attention — the PROBLEM lines above say what."
    echo "OPERATOR_GUIDE.md explains each one under 'What can go wrong'."
fi
finish $CODE
