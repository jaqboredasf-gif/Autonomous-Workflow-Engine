"""Malformed, stale and unprovable knowledge, all caught before use."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from awe_knowledge import (
    EvidenceRef,
    KnowledgeDocument,
    KnowledgeRecord,
    RecordKind,
    TrustLevel,
    is_stale,
    validate_document,
    validate_record,
)
from conftest import ENVIRONMENT, INTEGRATION, TENANT

NOW = datetime(2026, 2, 1, tzinfo=timezone.utc)


def _document() -> KnowledgeDocument:
    return KnowledgeDocument(tenant=TENANT, integration=INTEGRATION,
                             environment=ENVIRONMENT)


def test_a_well_formed_record_passes(make_record):
    assert validate_record(make_record()) == []


def test_a_record_missing_its_required_payload_keys_fails(make_record):
    record = make_record(payload={"component": "sign-in form"})
    problems = validate_record(record)
    assert any("purpose" in p for p in problems)
    assert any("preferred" in p for p in problems)


def test_an_id_that_does_not_match_its_kind_and_name_fails(make_record):
    record = make_record()
    record.record_id = "selector:something-else"
    assert any("does not match" in p for p in validate_record(record))


def test_verified_without_evidence_is_refused(make_record):
    record = make_record(trust=TrustLevel.VERIFIED)
    record.verified_by_runs = ["run-1", "run-2"]
    assert any("without usable evidence" in p for p in validate_record(record))


def test_verified_on_a_single_execution_is_refused(make_record, make_evidence):
    record = make_record(trust=TrustLevel.VERIFIED)
    record.evidence.append(make_evidence("run-1"))
    record.verified_by_runs = ["run-1"]
    assert any("distinct" in p for p in validate_record(record))


def test_a_secret_in_a_payload_is_a_validation_problem(make_record):
    record = make_record(
        payload={
            "component": "sign-in form",
            "purpose": "the account name field",
            "preferred": {"by": "label", "value": "Username"},
            "selector_type": "label",
            "session_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
        }
    )
    assert any("secret" in p or "credential" in p for p in validate_record(record))


def test_a_secret_hidden_in_the_notes_is_caught(make_record):
    record = make_record()
    record.notes = "Authorization: Bearer abcdef123456789"
    assert any("credential" in p for p in validate_record(record))


def test_an_unreadable_expiry_is_a_problem(make_record):
    record = make_record(expires_at="next tuesday")
    assert any("not a readable time" in p for p in validate_record(record))


def test_verified_knowledge_goes_stale(make_record):
    record = make_record(trust=TrustLevel.VERIFIED)
    record.last_verified = (NOW - timedelta(days=45)).isoformat()
    assert is_stale(record, NOW) is True
    record.last_verified = (NOW - timedelta(days=5)).isoformat()
    assert is_stale(record, NOW) is False


def test_verified_knowledge_that_was_never_confirmed_counts_as_stale(make_record):
    record = make_record(trust=TrustLevel.VERIFIED)
    assert is_stale(record, NOW) is True


def test_an_unverified_record_is_never_called_stale(make_record):
    assert is_stale(make_record(trust=TrustLevel.CANDIDATE), NOW) is False


def test_document_validation_reports_each_problem_against_its_record(make_record):
    document = _document()
    document.put(make_record("login.username"))
    document.put(make_record("login.password", payload={"component": "x"}))

    report = validate_document(document, now=NOW)
    assert not report.ok
    assert all(p.startswith("selector:login.password") for p in report.problems)


def test_a_foreign_record_smuggled_into_a_document_is_caught(make_record):
    document = _document()
    stranger = make_record(tenant="someone-else")
    document.records[stranger.record_id] = stranger      # bypassing put() on purpose

    report = validate_document(document, now=NOW)
    assert any("another tenant" in p for p in report.problems)


def test_degraded_and_pending_records_are_warnings_not_failures(make_record,
                                                                make_evidence):
    document = _document()
    degraded = make_record("login.username", trust=TrustLevel.DEGRADED)
    document.put(degraded)
    waiting = make_record("login.password", approval_required=True)
    document.put(waiting)

    report = validate_document(document, now=NOW)
    assert report.ok
    assert any("DEGRADED" in w for w in report.warnings)
    assert any("awaiting approval" in w for w in report.warnings)


def test_an_expired_record_is_reported_as_stale(make_record, make_evidence):
    document = _document()
    record = make_record(trust=TrustLevel.VERIFIED,
                         expires_at="2026-01-15T00:00:00+00:00")
    record.evidence.append(make_evidence("run-1"))
    record.verified_by_runs = ["run-1", "run-2"]
    record.last_verified = "2026-01-20T00:00:00+00:00"
    document.put(record)

    report = validate_document(document, now=NOW)
    assert record.record_id in report.stale


def test_a_pending_change_is_surfaced_but_does_not_fail_the_document(make_record):
    document = _document()
    document.put(make_record())
    document.pending.append({"record_id": "selector:login.username", "status": "open"})

    report = validate_document(document, now=NOW)
    assert report.ok
    assert any("waiting for a decision" in w for w in report.warnings)


def test_a_secret_in_a_pending_change_fails_the_document(make_record):
    document = _document()
    document.put(make_record())
    document.pending.append(
        {
            "record_id": "selector:login.username",
            "status": "open",
            "proposed_payload": {"password": "hunter2xyz"},
        }
    )
    assert not validate_document(document, now=NOW).ok


def test_a_policy_record_needs_a_rule_and_a_scope(make_record):
    record = make_record("read-only", kind=RecordKind.POLICY,
                         payload={"rule": "never submit"})
    assert any("applies_to" in p for p in validate_record(record))


def test_evidence_from_a_run_with_no_artifact_still_counts():
    """A deterministic result is evidence even with nothing to screenshot."""
    from awe_knowledge import evidence_is_usable

    assert evidence_is_usable(
        EvidenceRef(execution_id="run-1", observed_at="2026-01-01T00:00:00Z",
                    kind="run")
    )
    assert not evidence_is_usable(
        EvidenceRef(execution_id="", observed_at="2026-01-01T00:00:00Z")
    )


def test_a_record_superseded_by_something_absent_is_a_problem(make_record):
    document = _document()
    record = make_record()
    record.superseded_by = "selector:login.username-v2"
    document.put(record)
    assert any("not in this document" in p
               for p in validate_document(document, now=NOW).problems)


def test_a_record_cannot_supersede_itself(make_record):
    record = make_record()
    record.superseded_by = record.record_id
    assert any("supersedes itself" in p for p in validate_record(record))


def test_the_schema_version_is_checked(make_record):
    document = _document()
    document.schema_version = 99
    assert any("schema version" in p
               for p in validate_document(document, now=NOW).problems)


def test_a_record_id_is_stable_across_a_round_trip(make_record):
    record = make_record()
    assert KnowledgeRecord.from_dict(record.to_dict()).to_dict() == record.to_dict()
