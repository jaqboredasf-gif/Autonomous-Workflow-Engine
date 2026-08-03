"""What it takes to be believed, and how quickly belief is withdrawn.

These are the tests that make the difference between a knowledge store and a
notes file. The claim "the system learns" is only honest if a single agent
assertion cannot become trusted knowledge, so that is what is checked here
first.
"""

from __future__ import annotations

import pytest

from awe_knowledge import (
    EvidenceRequired,
    RecordKind,
    TrustLevel,
    confirm_invalid,
    observe,
    record_failure,
    record_success,
)


def test_one_success_reaches_candidate_not_verified(make_record, make_evidence):
    record = make_record()
    change = record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    assert record.trust is TrustLevel.CANDIDATE
    assert change is not None and change.is_promotion


def test_the_same_execution_twice_never_reaches_verified(make_record, make_evidence):
    """One run reporting success twice is one run, not two witnesses."""
    record = make_record()
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:05:00Z")
    assert record.trust is TrustLevel.CANDIDATE
    assert record.verified_by_runs == ["run-1"]


def test_two_distinct_executions_reach_verified(make_record, make_evidence):
    record = make_record()
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    change = record_success(record, make_evidence("run-2"), at="2026-01-03T00:00:00Z")
    assert record.trust is TrustLevel.VERIFIED
    assert change is not None and change.after == "VERIFIED"
    assert record.last_verified == "2026-01-03T00:00:00Z"
    assert record.previous_good is not None       # a good state to fall back to


def test_success_without_usable_evidence_is_refused(make_record):
    from awe_knowledge import EvidenceRef

    record = make_record()
    with pytest.raises(EvidenceRequired):
        record_success(record, EvidenceRef(execution_id="", observed_at=""),
                       at="2026-01-02T00:00:00Z")
    assert record.trust is TrustLevel.DISCOVERED


def test_evidence_pointing_at_a_missing_artifact_is_not_evidence(make_record):
    from awe_knowledge import EvidenceRef

    record = make_record()
    ghost = EvidenceRef(
        execution_id="run-1", observed_at="2026-01-02T00:00:00Z", kind="run",
        artifacts=["/nowhere/screenshot.png"],
    )
    with pytest.raises(EvidenceRequired):
        record_success(record, ghost, at="2026-01-02T00:00:00Z")


def test_one_failure_knocks_verified_down_to_degraded(make_record, make_evidence):
    record = make_record()
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    record_success(record, make_evidence("run-2"), at="2026-01-03T00:00:00Z")
    change = record_failure(record, "selector not found", at="2026-01-04T00:00:00Z")
    assert record.trust is TrustLevel.DEGRADED
    assert change is not None and not change.is_promotion
    # Re-verification starts over; the old votes no longer count.
    assert record.verified_by_runs == []


def test_a_second_failure_invalidates(make_record, make_evidence):
    record = make_record()
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    record_success(record, make_evidence("run-2"), at="2026-01-03T00:00:00Z")
    record_failure(record, "not found", at="2026-01-04T00:00:00Z")
    record_failure(record, "not found again", at="2026-01-05T00:00:00Z")
    assert record.trust is TrustLevel.INVALID


def test_two_failures_inside_one_execution_do_not_invalidate(make_record,
                                                             make_evidence):
    """Trying the stored value and then a repair is one run's opinion."""
    record = make_record()
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    record_success(record, make_evidence("run-2"), at="2026-01-03T00:00:00Z")
    record_failure(record, "stored value failed", at="2026-01-04T00:00:00Z",
                   execution_id="run-3")
    record_failure(record, "the repair failed too", at="2026-01-04T00:01:00Z",
                   execution_id="run-3")
    assert record.trust is TrustLevel.DEGRADED

    # A second, independent run failing is what writes it off.
    record_failure(record, "still broken", at="2026-01-05T00:00:00Z",
                   execution_id="run-4")
    assert record.trust is TrustLevel.INVALID


def test_confirmed_incompatibility_invalidates_immediately(make_record, make_evidence):
    record = make_record()
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    record_failure(record, "the control was removed", at="2026-01-04T00:00:00Z",
                   confirmed_incompatible=True)
    assert record.trust is TrustLevel.INVALID


def test_invalid_knowledge_is_not_resurrected_by_a_passing_check(
    make_record, make_evidence
):
    record = make_record()
    confirm_invalid(record, "written off", at="2026-01-04T00:00:00Z")
    assert record_success(record, make_evidence("run-9"),
                          at="2026-01-05T00:00:00Z") is None
    assert record.trust is TrustLevel.INVALID


def test_written_off_knowledge_can_be_re_opened_as_an_observation(
    make_record, make_evidence
):
    record = make_record()
    confirm_invalid(record, "written off", at="2026-01-04T00:00:00Z")
    observe(record, "seen again on the page", at="2026-01-06T00:00:00Z")
    assert record.trust is TrustLevel.DISCOVERED
    # And it still has to earn its way back.
    record_success(record, make_evidence("run-9"), at="2026-01-06T00:00:00Z")
    assert record.trust is TrustLevel.CANDIDATE


def test_a_selector_record_mirrors_its_trust_into_its_status(
    make_record, make_evidence
):
    record = make_record(kind=RecordKind.SELECTOR)
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    assert record.payload["status"] == "candidate"
    record_success(record, make_evidence("run-2"), at="2026-01-03T00:00:00Z")
    assert record.payload["status"] == "verified"
    record_failure(record, "gone", at="2026-01-04T00:00:00Z")
    assert record.payload["status"] == "degraded"


def test_restoring_the_last_known_good_state(make_record, make_evidence):
    record = make_record()
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00Z")
    record_success(record, make_evidence("run-2"), at="2026-01-03T00:00:00Z")
    good_value = dict(record.payload["preferred"])

    record.payload["preferred"] = {"by": "css", "value": "#broken"}
    record_failure(record, "broken", at="2026-01-04T00:00:00Z")
    assert record.trust is TrustLevel.DEGRADED

    assert record.restore_good() is True
    assert record.payload["preferred"] == good_value
    assert record.trust is TrustLevel.VERIFIED
