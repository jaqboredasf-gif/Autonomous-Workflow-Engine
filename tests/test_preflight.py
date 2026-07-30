"""Prerequisite checks, including the two that are safety rather than setup."""

from __future__ import annotations

from pathlib import Path

import pytest

from tegg import preflight

REPO_ROOT = Path(__file__).resolve().parents[1]


def _assets(tmp_path: Path) -> Path:
    folder = tmp_path / "static"
    folder.mkdir()
    for name in preflight.REQUIRED_ASSETS:
        (folder / name).write_bytes(b"%PDF-1.4\n%not a real report\n")
    return folder


# --- the safety checks -----------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "",
        "http://127.0.0.1:8899",
        "http://localhost:8899/sales/documentation",
        "http://[::1]:8899",
    ],
)
def test_loopback_targets_are_allowed(url):
    assert preflight.target_is_local(url).status == preflight.OK


@pytest.mark.parametrize(
    "url",
    [
        "https://portal.teggpro.com",
        "http://10.0.0.4:8899",
        "https://127.0.0.1.evil.example.com",
    ],
)
def test_anything_that_is_not_loopback_blocks_the_run(url):
    # A whitelist, not a blacklist: a host that is merely unknown must fail,
    # because the run's whole premise is that it touches nothing external.
    item = preflight.target_is_local(url)
    assert item.status == preflight.FAIL
    assert item.blocking


def test_absent_live_credentials_warn_rather_than_block(monkeypatch):
    for name in preflight.LIVE_CREDENTIAL_VARS:
        monkeypatch.delenv(name, raising=False)
    item = preflight.credentials_are_environment_only()
    assert item.status == preflight.WARN
    assert not item.blocking
    assert "does not need them" in item.detail


def test_present_credentials_are_reported_without_their_values(monkeypatch):
    secret = "not-a-real-password-9f2b"
    for name in preflight.LIVE_CREDENTIAL_VARS:
        monkeypatch.setenv(name, secret)
    item = preflight.credentials_are_environment_only()
    assert item.status == preflight.OK
    assert secret not in item.detail
    assert secret not in str(item)


def test_a_gitignore_without_dotenv_blocks(tmp_path):
    (tmp_path / ".gitignore").write_text("*.pdf\n", encoding="utf-8")
    assert preflight.dotenv_is_ignored(tmp_path).status == preflight.FAIL


def test_a_gitignore_with_dotenv_passes(tmp_path):
    (tmp_path / ".gitignore").write_text("*.pdf\n.env\n", encoding="utf-8")
    assert preflight.dotenv_is_ignored(tmp_path).status == preflight.OK


def test_the_repository_itself_ignores_dotenv():
    assert preflight.dotenv_is_ignored(REPO_ROOT).status == preflight.OK


# --- the setup checks ------------------------------------------------------


def test_present_assets_pass(tmp_path):
    assert preflight.static_assets(_assets(tmp_path)).status == preflight.OK


def test_a_missing_asset_is_named(tmp_path):
    folder = _assets(tmp_path)
    (folder / preflight.REQUIRED_ASSETS[0]).unlink()
    item = preflight.static_assets(folder)
    assert item.status == preflight.FAIL
    assert preflight.REQUIRED_ASSETS[0] in item.detail


def test_an_empty_asset_is_caught_as_well_as_an_absent_one(tmp_path):
    folder = _assets(tmp_path)
    (folder / preflight.REQUIRED_ASSETS[1]).write_bytes(b"")
    item = preflight.static_assets(folder)
    assert item.status == preflight.FAIL
    assert "empty" in item.detail


def test_a_missing_assets_directory_fails(tmp_path):
    assert preflight.static_assets(tmp_path / "nope").status == preflight.FAIL


def test_a_writable_work_root_is_created_if_absent(tmp_path):
    target = tmp_path / "deep" / "work"
    item = preflight.output_writable(target)
    assert item.status == preflight.OK
    assert target.is_dir()


def test_an_unwritable_work_root_fails(tmp_path):
    target = tmp_path / "readonly"
    target.mkdir()
    target.chmod(0o500)
    try:
        assert preflight.output_writable(target).status == preflight.FAIL
    finally:
        target.chmod(0o700)


def test_the_probe_file_does_not_survive(tmp_path):
    preflight.output_writable(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_the_repository_case_file_covers_every_section():
    item = preflight.case_file(None)
    assert item.status == preflight.OK, item.detail
    assert "all 10 sections" in item.detail


def test_a_broken_case_file_is_reported_not_raised(tmp_path):
    bad = tmp_path / "cases.yaml"
    bad.write_text("cases:\n  - id: x\n    kind: nonsense\n", encoding="utf-8")
    item = preflight.case_file(bad)
    assert item.status == preflight.FAIL
    assert "nonsense" in item.detail


def test_the_local_portal_starts_answers_and_stops():
    item = preflight.portal_reachable()
    assert item.status == preflight.OK, item.detail


# --- the whole set ---------------------------------------------------------


def test_run_reports_ready_for_this_repository(tmp_path):
    checks = preflight.run(
        repo_root=REPO_ROOT,
        work_root=tmp_path / "work",
        assets_dir=_assets(tmp_path),
        cases_path=None,
        check_browser=False,
        check_portal=False,
    )
    assert checks.ok, [i.detail for i in checks.blockers]
    assert {i.name for i in checks.items} >= {
        "target_is_local",
        "credentials",
        "dotenv_ignored",
        "static_assets",
        "case_file",
        "output_writable",
    }


def test_a_warning_alone_does_not_block(monkeypatch, tmp_path):
    for name in preflight.LIVE_CREDENTIAL_VARS:
        monkeypatch.delenv(name, raising=False)
    checks = preflight.run(
        repo_root=REPO_ROOT,
        work_root=tmp_path / "work",
        assets_dir=_assets(tmp_path),
        check_browser=False,
        check_portal=False,
    )
    assert checks.warnings
    assert checks.ok


def test_one_blocker_makes_the_whole_set_not_ready(tmp_path):
    checks = preflight.run(
        repo_root=REPO_ROOT,
        work_root=tmp_path / "work",
        assets_dir=tmp_path / "absent",
        check_browser=False,
        check_portal=False,
    )
    assert not checks.ok
    assert [i.name for i in checks.blockers] == ["static_assets"]


def test_the_summary_serialises_for_a_result_file(tmp_path):
    checks = preflight.run(
        repo_root=REPO_ROOT,
        work_root=tmp_path / "work",
        assets_dir=_assets(tmp_path),
        check_browser=False,
        check_portal=False,
    )
    data = checks.to_dict()
    assert data["ok"] is True
    assert data["blockers"] == []
    assert all({"name", "status", "detail"} == set(i) for i in data["items"])
