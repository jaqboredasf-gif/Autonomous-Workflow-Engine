"""The launcher scripts, which are the commands a coworker actually types.

Three defects lived here until a first-run rehearsal on 2026-08-03 found them,
and all three only appeared on the *documented default* path -- no arguments,
or a failure. Shell is not covered by the Python suite, so it gets its own.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from awe_runtime import workspace_root as root

SCRIPTS = ["visit-findings.sh", "documentation-read.sh"]


def _script(name: str) -> Path:
    return root.install_root() / "scripts" / name


def _run(name: str, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    environment = dict(os.environ)
    environment.pop("TEGG_USERNAME", None)
    environment.pop("TEGG_PASSWORD", None)
    environment.update(env or {})
    return subprocess.run(
        [str(_script(name)), *args],
        capture_output=True, text=True, timeout=120, env=environment,
    )


@pytest.mark.parametrize("name", SCRIPTS + ["_awe.sh"])
def test_the_script_is_valid_shell(name):
    assert subprocess.run(["bash", "-n", str(_script(name))]).returncode == 0


@pytest.mark.parametrize("name", SCRIPTS)
def test_the_script_is_executable(name):
    assert os.access(_script(name), os.X_OK), f"{name} is not executable"


@pytest.mark.parametrize("name", SCRIPTS)
def test_no_arguments_is_not_an_unbound_variable_error(name):
    """`"${ARGS[@]}"` under `set -u` on bash 3.2 killed the default path.

    The command with an argument worked, so this went unnoticed until somebody
    ran the one the README actually shows.
    """
    result = _run(name)
    assert "unbound variable" not in result.stderr, result.stderr
    assert "ARGS" not in result.stderr


@pytest.mark.parametrize("name", SCRIPTS)
def test_missing_credentials_are_named_and_never_echoed(name):
    result = _run(name)
    assert result.returncode == 4, "not ready, rather than tried and failed"
    assert "TEGG_USERNAME" in result.stderr and "TEGG_PASSWORD" in result.stderr
    assert "export TEGG_USERNAME='...'" in result.stderr


def test_a_failing_run_still_gets_its_exit_code_explained(tmp_path):
    """`set -e` meant `cmd; CODE=$?` never ran, so only success was explained."""
    script = _script("_awe.sh")
    probe = tmp_path / "probe.sh"
    probe.write_text(
        "set -euo pipefail\n"
        f"source {script}\n"
        "export AWE_PYTHON=/bin/sh\n"
        "awe_run -c 'exit 3' || echo \"caller saw $?\"\n",
        encoding="utf-8",
    )
    result = subprocess.run(["bash", str(probe)], capture_output=True, text=True,
                            timeout=60)
    assert "needs a person" in result.stdout
    assert "caller saw 3" in result.stdout


def test_every_platform_exit_code_has_a_sentence():
    from awe_runtime import exits

    script = _script("_awe.sh")
    for code in (exits.EXIT_OK, exits.EXIT_FAILED, exits.EXIT_USAGE,
                 exits.EXIT_NEEDS_HUMAN, exits.EXIT_NOT_READY):
        result = subprocess.run(
            ["bash", "-c", f"source {script}; awe_explain_exit {code}"],
            capture_output=True, text=True, timeout=60,
        )
        assert result.stdout.strip(), f"exit {code} has no explanation"
        assert "exit code" not in result.stdout, f"exit {code} fell through"
