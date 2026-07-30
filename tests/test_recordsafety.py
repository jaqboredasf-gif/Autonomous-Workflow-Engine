"""The rules that decide whether live automation may write to a record.

These are the highest-consequence assertions in the repository: a wrong verdict
here corrupts a real customer's delivered report. Every test states the failure
it exists to prevent.
"""

from __future__ import annotations

import pytest

from tegg import recordsafety
from tegg.sitevisit import SiteVisit


def _visit(**kwargs) -> SiteVisit:
    base = {
        "identifier": "T26-900",
        "label": "",
        "customer": "Northwind Manufacturing",
        "site": "Bay Street Plant",
        "status": "",
    }
    base.update(kwargs)
    return SiteVisit(**base)


# --- status classification --------------------------------------------------


@pytest.mark.parametrize(
    "status", ["Completed", "completed", "  COMPLETE  ", "Closed", "Finished"]
)
def test_finished_statuses_classify_as_completed(status):
    assert recordsafety.classify_status(status) == recordsafety.COMPLETED


@pytest.mark.parametrize("status", ["Draft", "New", "Not Started", "Unsubmitted"])
def test_draft_statuses_classify_as_draft(status):
    assert recordsafety.classify_status(status) == recordsafety.DRAFT


@pytest.mark.parametrize("status", ["In Progress", "in-progress", "Open", "Active"])
def test_working_statuses_classify_as_in_progress(status):
    assert recordsafety.classify_status(status) == recordsafety.IN_PROGRESS


def test_incomplete_is_never_read_as_complete():
    # "Incomplete" contains "complete". Substring matching here would classify
    # unfinished work as finished, which is the exact inversion that matters.
    assert recordsafety.classify_status("Incomplete") == recordsafety.IN_PROGRESS
    assert recordsafety.classify_status("Incomplete") != recordsafety.COMPLETED


@pytest.mark.parametrize("status", ["", "   ", "Awaiting QA", "Escalated", "???"])
def test_an_unrecognised_status_is_unknown_rather_than_a_guess(status):
    assert recordsafety.classify_status(status) == recordsafety.UNKNOWN


# --- test-record detection --------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "TEST SITE",
        "Automation Sandbox",
        "ZZ-Demo Customer",
        "Training Plant",
        "QA Facility",
        "DO NOT USE - rig",
    ],
)
def test_records_that_announce_themselves_as_tests_are_recognised(name):
    assert recordsafety.looks_like_a_test_record(name)


@pytest.mark.parametrize(
    "name", ["Northwind Manufacturing", "Atlas Capital", "The Factory", ""]
)
def test_ordinary_customer_names_are_not_mistaken_for_test_records(name):
    assert not recordsafety.looks_like_a_test_record(name)


def test_the_marker_may_appear_in_any_identifying_field():
    assert recordsafety.classify(
        _visit(customer="Acme", site="TEST RIG", status="Draft")
    ) == recordsafety.TEST
    assert recordsafety.classify(
        _visit(identifier="SANDBOX-01", status="Draft")
    ) == recordsafety.TEST


def test_a_substring_alone_does_not_make_a_record_a_test():
    # "Contest" and "Protest" contain "test". Word boundaries matter.
    assert not recordsafety.looks_like_a_test_record("Contest Industries")
    assert not recordsafety.looks_like_a_test_record("Protestant Hospital Trust")


# --- the writability verdict ------------------------------------------------


def test_a_completed_customer_record_is_never_writable():
    verdict = recordsafety.assess(_visit(status="Completed"))
    assert not verdict.writable
    assert "delivered work" in verdict.reason


def test_naming_a_completed_record_test_does_not_make_it_writable():
    # The rule that stops the obvious workaround. A finished record is
    # finished; calling it a sandbox does not unfinish it.
    verdict = recordsafety.assess(
        _visit(customer="TEST Customer", site="SANDBOX", status="Completed")
    )
    assert verdict.classification == recordsafety.COMPLETED
    assert not verdict.writable


def test_a_named_test_record_is_writable():
    verdict = recordsafety.assess(
        _visit(customer="ZZ-AUTOMATION TEST", status="Draft")
    )
    assert verdict.writable
    assert verdict.classification == recordsafety.TEST


@pytest.mark.parametrize("status", ["Draft", "In Progress", "Incomplete"])
def test_unfinished_real_customer_work_is_still_refused(status):
    # Unfinished is not the same as set-aside-for-automation.
    verdict = recordsafety.assess(_visit(status=status))
    assert not verdict.writable
    assert "not a record set aside for automation" in verdict.reason


@pytest.mark.parametrize("status", ["", "Awaiting QA", "something new"])
def test_an_unrecognised_status_is_refused_rather_than_guessed(status):
    verdict = recordsafety.assess(_visit(status=status))
    assert not verdict.writable
    assert "refusing rather than guessing" in verdict.reason


def test_every_refusal_states_a_reason():
    for status in ("Completed", "Draft", "In Progress", "", "Nonsense"):
        verdict = recordsafety.assess(_visit(status=status))
        if not verdict.writable:
            assert verdict.reason.strip()


def test_the_default_for_an_empty_record_is_refusal():
    # Whatever else changes, a record carrying no information must never be
    # writable. This is the fail-closed guarantee.
    assert not recordsafety.assess(SiteVisit(identifier="")).writable


# --- surveying a whole listing ----------------------------------------------


def test_a_survey_counts_each_classification():
    survey = recordsafety.survey(
        [
            _visit(identifier="A", status="Completed"),
            _visit(identifier="B", status="Completed"),
            _visit(identifier="C", status="Draft"),
            _visit(identifier="D", customer="TEST RIG", status="Draft"),
        ]
    )
    counts = survey.counts()
    assert counts[recordsafety.COMPLETED] == 2
    assert counts[recordsafety.DRAFT] == 1
    assert counts[recordsafety.TEST] == 1


def test_a_listing_of_only_real_customer_work_offers_nothing_writable():
    # The situation this repository is actually in today.
    survey = recordsafety.survey(
        [
            _visit(identifier="T25-204", status="Completed"),
            _visit(identifier="T25-205", status="Incomplete"),
        ]
    )
    assert survey.writable == []
    assert survey.safest is None


def test_the_safest_record_is_the_writable_one():
    survey = recordsafety.survey(
        [
            _visit(identifier="T25-204", status="Completed"),
            _visit(identifier="ZZ-TEST-01", customer="ZZ TEST", status="Draft"),
        ]
    )
    assert survey.safest is not None
    assert survey.safest.identifier == "ZZ-TEST-01"


def test_a_survey_serialises_for_the_json_result():
    survey = recordsafety.survey([_visit(identifier="T25-204", status="Completed")])
    data = survey.to_dict()
    assert data["total"] == 1
    assert data["safest"] is None
    assert data["writable"] == []
    assert data["verdicts"][0]["classification"] == recordsafety.COMPLETED


def test_an_empty_listing_surveys_cleanly():
    survey = recordsafety.survey([])
    assert survey.safest is None
    assert survey.counts() == {}
