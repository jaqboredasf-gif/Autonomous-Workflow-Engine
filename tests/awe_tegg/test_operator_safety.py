"""The mistakes a first-time coworker actually makes, and what happens.

These are regression tests for behaviour found by running the tool wrongly on
purpose rather than by reading it. The worst one, reproduced on 2026-08-03:

    $ cd /tmp
    $ python -m awe_tegg run visit-findings

signed into the live portal, retrieved two real customers' inspection reports
into ``/tmp``, parsed them, generated recommendations, and only then stopped --
on a missing rate card. 1.5 MB of customer data in a world-readable directory,
and an error message that sent the reader looking at config files rather than
at where they were standing.

Nothing here needs a portal, a browser or a credential.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from awe_tegg import cli                                    # noqa: E402
from awe_tegg import workspace_root as root                 # noqa: E402


def _args(**overrides) -> argparse.Namespace:
    base = dict(service_file=None, work_root=None, rate_card=None,
                base_url=None, headed=False, json=False, run_id=None,
                discovery_actions=None, discovery_seconds=None,
                site_visit=None, include_corrected=False, online=False)
    base.update(overrides)
    return argparse.Namespace(**base)


# -- where you are standing ----------------------------------------------


def test_the_installation_is_found_from_the_code_not_the_shell(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert root.install_root() == Path(__file__).resolve().parents[2]
    assert root.looks_like_installation(root.install_root())


def test_a_relative_default_resolves_against_the_installation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    resolved = root.resolve("work")
    assert resolved == root.install_root() / "work"
    assert not str(resolved).startswith(str(tmp_path))


def test_a_path_somebody_typed_in_full_is_left_alone(tmp_path):
    assert root.resolve(tmp_path / "elsewhere") == tmp_path / "elsewhere"


def test_running_from_outside_the_installation_is_refused_in_words(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(root.NotInInstallation) as caught:
        root.require_installation()
    message = str(caught.value)
    assert str(tmp_path.resolve()) in message, "it must say where you are"
    assert f"cd {root.install_root()}" in message, "it must say what to do"
    assert "customer documents" in message, "it must say why it matters"


def test_the_root_can_be_overridden_for_an_unusual_layout(tmp_path, monkeypatch):
    monkeypatch.setenv(root.ENV_ROOT, str(tmp_path))
    assert root.install_root() == tmp_path.resolve()
    assert root.ENV_ROOT in root.describe_root()


# -- preflight happens before the browser, not after the download --------


def test_the_wrong_directory_is_the_only_thing_reported(tmp_path, monkeypatch):
    """Every other check would be a guess, so none of them is offered."""
    monkeypatch.chdir(tmp_path)
    problems = cli.preflight_problems(_args(), operation="visit-findings")
    assert len(problems) == 1
    assert "not inside the TEGG installation" in problems[0]


def test_a_missing_rate_card_is_caught_before_anything_expensive(tmp_path, monkeypatch):
    """It used to be checked at step 10 of 13, after two PDFs had been fetched."""
    monkeypatch.setenv("TEGG_USERNAME", "someone")
    monkeypatch.setenv("TEGG_PASSWORD", "something")
    problems = cli.preflight_problems(
        _args(rate_card=str(tmp_path / "nope.yaml")), operation="visit-findings"
    )
    assert any("no rate card at" in p for p in problems)


def test_missing_credentials_are_named_with_the_command_to_fix_them(monkeypatch):
    monkeypatch.delenv("TEGG_USERNAME", raising=False)
    monkeypatch.delenv("TEGG_PASSWORD", raising=False)
    problems = cli.preflight_problems(_args())
    assert any("TEGG_USERNAME" in p and "export" in p for p in problems)
    assert any("TEGG_PASSWORD" in p for p in problems)


def test_a_run_started_in_the_wrong_place_contacts_nothing(tmp_path, monkeypatch, capsys):
    """The whole point: exit before the browser, and say so."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TEGG_USERNAME", "someone")
    monkeypatch.setenv("TEGG_PASSWORD", "something")

    code = cli.main(["run", "visit-findings"])
    captured = capsys.readouterr()

    assert code == cli.EXIT_NEEDS_HUMAN
    assert "the portal was not contacted" in captured.err
    assert "not inside the TEGG installation" in captured.err
    # and nothing was created where they were standing
    assert not (tmp_path / "work").exists()
    assert not (tmp_path / "data").exists()


# -- doctor changes nothing ----------------------------------------------


def test_the_writability_probe_does_not_create_the_directory(tmp_path):
    """`doctor` is documented as changing nothing. It was creating a tree."""
    target = tmp_path / "does" / "not" / "exist"
    ok, detail = cli._writable(target)
    assert ok, "it is writable -- the parent exists and permits it"
    assert "will be created" in detail
    assert not target.exists(), "the probe must not have made it"


def test_the_probe_reports_a_directory_it_genuinely_cannot_write(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        ok, detail = cli._writable(locked / "child")
        assert not ok
        assert "not writable" in detail
    finally:
        locked.chmod(0o700)


@pytest.mark.skipif(os.geteuid() == 0, reason="root can write anywhere")
def test_doctor_creates_nothing_anywhere(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    before = set(tmp_path.rglob("*"))
    cli.main(["doctor"])
    assert set(tmp_path.rglob("*")) == before


# -- the service file ----------------------------------------------------


def test_the_default_service_file_is_found_without_being_named():
    found = cli._service_file(_args())
    assert found is not None
    assert found.name == "service.yaml"
    assert found.exists()


def test_the_old_service_file_name_still_works(capsys):
    """A coworker's script or a printed runbook may still say the old path."""
    found = cli._service_file(
        _args(service_file="config/service.documentation-read.yaml")
    )
    assert found is not None and found.exists()
    assert found.name == "service.yaml"
    assert "is now config/service.yaml" in capsys.readouterr().err


def test_a_service_file_that_is_simply_missing_is_still_an_error(tmp_path):
    problems = cli.preflight_problems(
        _args(service_file=str(tmp_path / "nothing.yaml"))
    )
    assert any("no service file at" in p for p in problems)
