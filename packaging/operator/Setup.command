#!/usr/bin/env bash
#
# TEGG Report Tool — one-time setup.
#
# Double-click this once. It checks what your Mac needs, installs the tool
# into this folder, and asks for your TEGG sign-in so you do not have to type
# it every time.
#
# It does not change anything outside this folder, apart from saving your
# password in the macOS Keychain, which is the same place Safari keeps them.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE="$(pwd)"

KEYCHAIN_SERVICE="TEGG Report Tool"
MIN_PY_MAJOR=3
MIN_PY_MINOR=10

say()  { printf '%s\n' "$*"; }
head2() { printf '\n%s\n%s\n' "$*" "$(printf '%.0s-' $(seq 1 ${#1}))"; }
ok()   { printf '  OK       %s\n' "$*"; }
bad()  { printf '  PROBLEM  %s\n' "$*"; }

finish() {
    say ""
    say "Press Return to close this window."
    read -r _ || true
    exit "${1:-0}"
}

say "TEGG Report Tool — setup"
say "Folder: $HERE"

# ---------------------------------------------------------------- python ---
head2 "Checking Python"

find_python() {
    local candidate
    for candidate in \
        /opt/homebrew/bin/python3 /usr/local/bin/python3 \
        "$(command -v python3 2>/dev/null || true)" \
        /usr/bin/python3
    do
        [ -n "$candidate" ] && [ -x "$candidate" ] || continue
        if "$candidate" -c "import sys; raise SystemExit(0 if sys.version_info >= ($MIN_PY_MAJOR,$MIN_PY_MINOR) else 1)" 2>/dev/null; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

if PYTHON="$(find_python)"; then
    ok "$("$PYTHON" --version 2>&1) at $PYTHON"
else
    bad "No Python $MIN_PY_MAJOR.$MIN_PY_MINOR or newer was found."
    say ""
    say "  macOS comes with Python 3.9, which is too old for this tool."
    say "  You need to install a newer one. Either:"
    say ""
    say "    1. Download it from  https://www.python.org/downloads/"
    say "       Choose the big yellow button, open the installer, click through."
    say ""
    say "    2. Or, if you have Homebrew:   brew install python@3.12"
    say ""
    say "  Then double-click this Setup file again."
    finish 4
fi

# ------------------------------------------------------------ the tool -----
head2 "Installing the tool into this folder"

if [ -d "$HERE/.venv" ]; then
    say "  (found an existing installation; refreshing it)"
else
    "$PYTHON" -m venv "$HERE/.venv" || {
        bad "Could not create the installation folder."
        say "  This usually means the folder is read-only. Try moving the whole"
        say "  TEGG-Report-Tool folder to your Desktop and running Setup again."
        finish 4
    }
fi
VENV_PY="$HERE/.venv/bin/python"

say "  installing components (this takes a minute or two)..."
if ! "$VENV_PY" -m pip install --quiet --upgrade pip 2>/dev/null; then
    say "  (could not update pip; continuing)"
fi
if "$VENV_PY" -m pip install --quiet -e "$HERE" 2>"$HERE/.setup-install.log"; then
    ok "components installed"
else
    bad "Could not install the components."
    say ""
    say "  The details are in .setup-install.log next to this file."
    say "  The most common cause is no internet connection."
    finish 4
fi

# --------------------------------------------------------------- browser ---
head2 "Installing the browser it drives"
say "  downloading Chromium (about 150 MB, once)..."
if "$VENV_PY" -m playwright install chromium >"$HERE/.setup-browser.log" 2>&1; then
    ok "browser ready"
else
    bad "The browser could not be downloaded."
    say "  Details in .setup-browser.log. Usually this is the internet"
    say "  connection, or a company firewall blocking the download."
    finish 4
fi

# ----------------------------------------------------------- credentials ---
head2 "Your TEGG sign-in"
say "  These are stored in the macOS Keychain — the same place Safari keeps"
say "  your passwords. They are never written into a file in this folder."
say ""

EXISTING_USER="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a username -w 2>/dev/null || true)"
if [ -n "$EXISTING_USER" ]; then
    say "  Already saved for: $EXISTING_USER"
    printf '  Replace it? [y/N] '
    read -r replace || replace=""
    case "$replace" in
        [Yy]*) ;;
        *) ok "keeping the saved sign-in"; SKIP_CREDS=1 ;;
    esac
fi

if [ -z "${SKIP_CREDS:-}" ]; then
    printf '  TEGG username: '
    read -r TEGG_USER || TEGG_USER=""
    printf '  TEGG password (it will not appear as you type): '
    stty -echo 2>/dev/null || true
    read -r TEGG_PASS || TEGG_PASS=""
    stty echo 2>/dev/null || true
    printf '\n'

    if [ -z "$TEGG_USER" ] || [ -z "$TEGG_PASS" ]; then
        bad "Both a username and a password are needed."
        say "  Run Setup again when you have them."
        finish 4
    fi

    security delete-generic-password -s "$KEYCHAIN_SERVICE" -a username >/dev/null 2>&1 || true
    security delete-generic-password -s "$KEYCHAIN_SERVICE" -a password >/dev/null 2>&1 || true
    security add-generic-password -s "$KEYCHAIN_SERVICE" -a username -w "$TEGG_USER" -U 2>/dev/null
    security add-generic-password -s "$KEYCHAIN_SERVICE" -a password -w "$TEGG_PASS" -U 2>/dev/null
    unset TEGG_PASS
    ok "saved to the Keychain"
fi

# -------------------------------------------------------------- check it ---
head2 "Checking everything works together"
TEGG_USERNAME="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a username -w 2>/dev/null || true)" \
TEGG_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a password -w 2>/dev/null || true)" \
    "$HERE/.venv/bin/awe-tegg" doctor
CODE=$?

say ""
if [ "$CODE" -eq 0 ]; then
    say "Setup finished."
    say ""
    say "To use the tool, double-click:   Run Report.command"
    say "If anything ever looks wrong:    Check Setup.command"
    say ""
    say "Read START HERE.txt if you have not already."
else
    say "Setup did not finish cleanly — see the PROBLEM lines above."
    say "OPERATOR_GUIDE.md explains each one."
fi
finish "$CODE"
