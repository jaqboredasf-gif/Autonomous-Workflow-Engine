#!/usr/bin/env bash
#
# Shared preamble for AWE capability launcher scripts. Source it; do not run it.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/_awe.sh"
#   awe_require_credentials TEGG_USERNAME TEGG_PASSWORD
#   awe_run -m awe_tegg run visit-findings "$@"
#
# Exists because the same four things go wrong in every launcher script anyone
# writes, and three of them were live in this repository until a first-run
# rehearsal on 2026-08-03 found them:
#
#   * `set -u` with an empty array. `"${ARGS[@]}"` is an unbound-variable error
#     on bash 3.2 -- which is what macOS ships -- when ARGS is empty. The
#     no-argument path is the *documented default*, so the headline command
#     failed and the one with an argument worked.
#
#   * `set -e` swallowing the exit code. `cmd; CODE=$?` never reaches the
#     assignment when cmd fails, so the friendly "here is what that code means"
#     block only ever ran on success.
#
#   * running from wherever the operator happened to be standing.
#
#   * printing a credential, or checking one by echoing it.
#
# Nothing here reads a credential's value. It checks whether the variable is
# set and reports the name only.

# The installation this script belongs to, regardless of the caller's cwd.
awe_root() {
    cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

# The interpreter to use: the capability's virtual environment if it has one,
# an explicit $PYTHON if the caller set one, otherwise whatever python3 is.
awe_python() {
    local root="$1"
    if [[ -n "${PYTHON:-}" ]]; then
        printf '%s' "$PYTHON"
        return 0
    fi
    if [[ -x "$root/.venv/bin/python" ]]; then
        printf '%s' "$root/.venv/bin/python"
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        printf '%s' "$(command -v python3)"
        return 0
    fi
    return 1
}

# Refuse, naming what is missing, without ever reading a value.
awe_require_credentials() {
    local missing=()
    local name
    for name in "$@"; do
        [[ -n "${!name:-}" ]] || missing+=("$name")
    done
    if (( ${#missing[@]} > 0 )); then
        {
            echo "Not set: ${missing[*]}"
            echo
            echo "Set them in this terminal, then run this again:"
            for name in "${missing[@]}"; do
                echo "  export $name='...'"
            done
            echo
            echo "They are used to sign in and are never saved to disk."
            echo "Each terminal window is separate."
        } >&2
        return 1
    fi
    return 0
}

# Translate an exit code into a sentence. Mirrors awe_runtime.exits; the
# numbers are the platform contract, not this script's choice.
awe_explain_exit() {
    case "${1:-0}" in
        0) echo "Done." ;;
        1) echo "Could not continue. Nothing was changed in the portal." ;;
        2) echo "That command line was not understood. Nothing was attempted." ;;
        3) echo "Stopped and needs a person -- read 'human action required' above." ;;
        4) echo "Not ready: nothing was attempted and nothing was contacted." ;;
        *) echo "Finished with exit code $1." ;;
    esac
}

# Run the capability and return its real exit code.
#
# `set -e` would otherwise kill the script the moment the command failed, so
# the caller never gets to explain what happened. The `|| code=$?` is the whole
# point of this function.
awe_run() {
    local code=0
    "$AWE_PYTHON" "$@" || code=$?
    echo
    awe_explain_exit "$code"
    return "$code"
}
