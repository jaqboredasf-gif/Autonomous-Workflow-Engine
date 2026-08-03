"""Contradiction, approval, supersession and expiry.

Trust answers "how sure are we". These are the cases trust cannot express:
knowledge that disagrees with itself, knowledge a person has to sign off,
knowledge replaced by something better, and knowledge that simply aged out.
"""

from __future__ import annotations

from awe_knowledge import (
    KnowledgeDocument,
    RecordKind,
    TrustLevel,
    decide_pending,
    expire,
    find_contradictions,
    open_pending,
    propose_change,
    record_success,
    supersede,
)
from conftest import ENVIRONMENT, INTEGRATION, TENANT

AT = "2026-02-01T00:00:00+00:00"


def _document() -> KnowledgeDocument:
    return KnowledgeDocument(tenant=TENANT, integration=INTEGRATION,
                             environment=ENVIRONMENT)


def _verified(record, make_evidence):
    record_success(record, make_evidence("run-1"), at="2026-01-02T00:00:00+00:00")
    record_success(record, make_evidence("run-2"), at="2026-01-03T00:00:00+00:00")
    assert record.trust is TrustLevel.VERIFIED
    return record


# -- contradiction --------------------------------------------------------
def test_a_new_key_enriches_and_does_not_contradict(make_record):
    record = make_record()
    assert find_contradictions(record, {"page": "/auth/login"}) == []


def test_a_changed_value_is_a_contradiction(make_record):
    record = make_record()
    found = find_contradictions(record, {"preferred": {"by": "css", "value": "#u"}})
    assert [c.field for c in found] == ["preferred"]


def test_an_observation_refines_untrusted_knowledge_in_place(make_record):
    document = _document()
    record = make_record()
    document.put(record)

    pending, contradictions = propose_change(
        document, record, {"preferred": {"by": "css", "value": "#u"}},
        reason="looked again", at=AT,
    )
    assert pending is None and contradictions
    assert record.payload["preferred"]["value"] == "#u"
    assert document.pending == []


def test_an_observation_contradicting_verified_knowledge_is_queued_not_applied(
    make_record, make_evidence
):
    document = _document()
    record = _verified(make_record(), make_evidence)
    document.put(record)

    pending, contradictions = propose_change(
        document, record, {"preferred": {"by": "css", "value": "#u"}},
        reason="the label changed", at=AT, execution_id="run-3",
    )
    assert pending is not None
    assert record.payload["preferred"]["value"] == "Username"    # untouched
    assert [p.record_id for p in open_pending(document)] == [record.record_id]
    assert pending.contradictions[0]["field"] == "preferred"
    assert contradictions


def test_a_policy_is_never_changed_by_a_run_alone(make_record):
    document = _document()
    record = make_record("read-only", kind=RecordKind.POLICY)
    document.put(record)

    pending, _ = propose_change(
        document, record, {"rule": "submit freely"}, reason="a run decided", at=AT,
    )
    assert pending is not None
    assert record.payload["rule"] == "never submit"


# -- approval -------------------------------------------------------------
def test_approval_applies_the_change_and_names_who_approved_it(
    make_record, make_evidence
):
    document = _document()
    record = _verified(make_record(), make_evidence)
    document.put(record)
    propose_change(document, record, {"preferred": {"by": "css", "value": "#u"}},
                   reason="the label changed", at=AT, execution_id="run-3")

    changes = decide_pending(document, record.record_id, approve=True,
                             decided_by="jack", at="2026-02-02T00:00:00+00:00")
    assert record.payload["preferred"]["value"] == "#u"
    assert record.approved_by == "jack"
    assert open_pending(document) == []
    # Changed knowledge is no longer the knowledge that was verified.
    assert record.trust is TrustLevel.CANDIDATE
    assert [c.after for c in changes] == ["CANDIDATE"]
    assert record.verified_by_runs == []


def test_rejection_leaves_the_record_exactly_as_it_was(make_record, make_evidence):
    document = _document()
    record = _verified(make_record(), make_evidence)
    document.put(record)
    before = record.to_dict()
    propose_change(document, record, {"preferred": {"by": "css", "value": "#u"}},
                   reason="the label changed", at=AT, execution_id="run-3")

    decide_pending(document, record.record_id, approve=False, decided_by="jack",
                   at="2026-02-02T00:00:00+00:00")
    assert record.to_dict() == before
    assert open_pending(document) == []
    assert document.pending[0]["status"] == "rejected"


def test_a_record_awaiting_approval_is_not_usable(make_record, make_evidence):
    record = _verified(make_record(approval_required=True), make_evidence)
    assert record.usable(AT) is False
    record.approved_by, record.approved_at = "jack", AT
    assert record.usable(AT) is True


# -- supersession ---------------------------------------------------------
def test_superseding_keeps_the_old_record_and_marks_it(make_record, make_evidence):
    document = _document()
    old = _verified(make_record("login.username"), make_evidence)
    document.put(old)
    new = make_record("login.username-v2")

    change = supersede(document, old.record_id, new, reason="the form was rebuilt",
                       at=AT)
    assert old.trust is TrustLevel.INVALID
    assert old.superseded_by == new.record_id
    assert new.supersedes == old.record_id
    assert change is not None and change.after == "INVALID"
    assert old.record_id in document.records          # kept, not deleted


def test_a_superseded_record_is_not_usable_whatever_its_trust(make_record,
                                                              make_evidence):
    record = _verified(make_record(), make_evidence)
    record.superseded_by = "selector:login.username-v2"
    assert record.usable(AT) is False


# -- expiry ---------------------------------------------------------------
def test_expiry_demotes_to_candidate_rather_than_invalidating(make_record,
                                                              make_evidence):
    document = _document()
    record = _verified(make_record(expires_at="2026-01-20T00:00:00+00:00"),
                       make_evidence)
    document.put(record)

    changes = expire(document, now_iso=AT)
    assert record.trust is TrustLevel.CANDIDATE
    assert [c.record_id for c in changes] == [record.record_id]
    # And it can be earned back the normal way.
    record_success(record, make_evidence("run-4"), at=AT)
    record_success(record, make_evidence("run-5"), at=AT)
    assert record.trust is TrustLevel.VERIFIED


def test_a_record_with_no_expiry_never_expires(make_record, make_evidence):
    document = _document()
    record = _verified(make_record(), make_evidence)
    document.put(record)
    assert expire(document, now_iso="2099-01-01T00:00:00+00:00") == []
    assert record.trust is TrustLevel.VERIFIED


def test_an_expiry_that_cannot_be_read_is_treated_as_expired(make_record):
    record = make_record(expires_at="whenever")
    assert record.is_expired(AT) is True
