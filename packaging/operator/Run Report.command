#!/usr/bin/env bash
#
# TEGG Report Tool — read one completed site visit and write a report to review.
#
# Double-click this. It takes about a minute and a half.
#
# It only ever reads from TEGG. It never submits anything, approves anything,
# sends an email, or changes a record.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE="$(pwd)"
KEYCHAIN_SERVICE="TEGG Report Tool"

finish() {
    printf '\n%s\n' "Press Return to close this window."
    read -r _ || true
    exit "${1:-0}"
}

if [ ! -x "$HERE/.venv/bin/awe-tegg" ]; then
    echo "This tool has not been set up on this Mac yet."
    echo ""
    echo "Double-click  Setup.command  first. It only needs doing once."
    finish 4
fi

TEGG_USERNAME="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a username -w 2>/dev/null || true)"
TEGG_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a password -w 2>/dev/null || true)"
if [ -z "$TEGG_USERNAME" ] || [ -z "$TEGG_PASSWORD" ]; then
    echo "Your TEGG sign-in is not saved on this Mac."
    echo ""
    echo "Double-click  Setup.command  and enter it when asked."
    finish 4
fi
export TEGG_USERNAME TEGG_PASSWORD

# A site visit may be given as an argument, or by dropping nothing at all --
# in which case the tool picks the most recently completed one and says so.
ARGS=()
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
    ARGS+=(--site-visit "$1")
    shift
fi
if [ -f "$HERE/config/ratecard.yaml" ]; then
    ARGS+=(--rate-card config/ratecard.yaml)
fi

echo "Reading one completed site visit from TEGG."
echo "This takes about a minute and a half. You can leave it running."
echo ""

CODE=0
"$HERE/.venv/bin/awe-tegg" run visit-findings ${ARGS[@]+"${ARGS[@]}"} "$@" || CODE=$?

echo ""
case $CODE in
  0)
    echo "Done."
    LATEST="$(ls -td "$HERE"/work/operations/*/ 2>/dev/null | head -1)"
    if [ -n "$LATEST" ] && [ -f "$LATEST/review/review.md" ]; then
        echo "The report to read is:"
        echo "  ${LATEST}review/review.md"
        echo ""
        echo "Opening the folder for you..."
        open "$LATEST/review" 2>/dev/null || true
    fi
    ;;
  1) echo "It could not finish. Nothing in TEGG was changed."
     echo "See 'What can go wrong' in OPERATOR_GUIDE.md." ;;
  2) echo "That command was not understood. Nothing was attempted." ;;
  3) echo "It stopped and needs a person."
     echo "Read the 'human action required' lines above — they say what is needed."
     echo "Nothing in TEGG was changed, and you can safely run this again." ;;
  4) echo "It did not start: something about this Mac or its settings is not ready."
     echo "Double-click  Check Setup.command  to see what." ;;
  *) echo "Finished with code $CODE." ;;
esac
finish $CODE
