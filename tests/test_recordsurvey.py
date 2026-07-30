"""The read-only survey, driven through a real browser against a mock portal.

test_recordsafety.py proves the classification rules in isolation. This proves
the path that feeds them: that enumeration can actually see non-completed rows,
which it could not before, and that the survey reaches the right verdict about
what may be written to.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

pytest.importorskip("playwright")

from mock_sitevisit import PASSWORD, USERNAME, MockSiteVisitPortal  # noqa: E402

from tegg import evidence, recordsafety  # noqa: E402
from tegg.browser import launch  # noqa: E402
from tegg.sitevisit import Explorer  # noqa: E402

SETTINGS = {
    "login_path": "/auth/login",
    "login_labels": {"username": "User Id", "password": "Password", "submit": "Log In"},
    "documentation_labels": ["Documentation"],
}


@pytest.fixture(scope="module")
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        instance = launch(playwright, headless=True)
        yield instance
        instance.close()


def _visits(browser, tmp_path, *, keep_all_statuses):
    with MockSiteVisitPortal() as portal:
        context = browser.new_context()
        page = context.new_page()
        try:
            explorer = Explorer(
                page,
                portal.url,
                evidence.Recorder(tmp_path / "evidence"),
                SETTINGS,
                keep_all_statuses=keep_all_statuses,
            )
            explorer.login(USERNAME, PASSWORD, None)
            explorer.open_documentation()
            return explorer.list_completed_site_visits()
        finally:
            context.close()


def test_the_default_still_returns_only_completed_visits(browser, tmp_path):
    # The fetch path depends on this. Widening enumeration must not change it.
    visits = _visits(browser, tmp_path, keep_all_statuses=False)
    assert visits
    assert all(
        recordsafety.classify_status(v.status) == recordsafety.COMPLETED
        for v in visits
    ), [v.status for v in visits]


def test_keeping_all_statuses_surfaces_the_unfinished_rows(browser, tmp_path):
    # The defect this fixed: enumeration discarded every non-completed row, so
    # nothing could classify a listing or find a test record in it.
    everything = _visits(browser, tmp_path, keep_all_statuses=True)
    completed_only = _visits(browser, tmp_path, keep_all_statuses=False)
    assert len(everything) > len(completed_only)
    statuses = {recordsafety.classify_status(v.status) for v in everything}
    assert recordsafety.COMPLETED in statuses
    assert recordsafety.IN_PROGRESS in statuses


def test_the_survey_classifies_a_real_listing_read_through_a_browser(
    browser, tmp_path
):
    survey = recordsafety.survey(_visits(browser, tmp_path, keep_all_statuses=True))
    counts = survey.counts()
    assert counts.get(recordsafety.COMPLETED, 0) >= 2
    assert counts.get(recordsafety.TEST, 0) == 1


def test_the_survey_names_the_test_rig_as_the_safest_record(browser, tmp_path):
    survey = recordsafety.survey(_visits(browser, tmp_path, keep_all_statuses=True))
    safest = survey.safest
    assert safest is not None
    assert safest.classification == recordsafety.TEST
    assert safest.writable


def test_no_completed_visit_is_ever_marked_writable(browser, tmp_path):
    # The guarantee that matters most, asserted against a listing read from a
    # real page rather than from hand-built objects.
    survey = recordsafety.survey(_visits(browser, tmp_path, keep_all_statuses=True))
    for verdict in survey.verdicts:
        if verdict.classification == recordsafety.COMPLETED:
            assert not verdict.writable


def test_the_survey_serialises_what_a_live_run_would_need(browser, tmp_path):
    survey = recordsafety.survey(_visits(browser, tmp_path, keep_all_statuses=True))
    data = survey.to_dict()
    assert data["total"] >= 3
    assert data["safest"]
    assert all(
        {"identifier", "classification", "writable", "reason"} == set(v)
        for v in data["verdicts"]
    )
