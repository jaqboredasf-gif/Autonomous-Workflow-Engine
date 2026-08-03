"""Checks a knowledge document must pass before anything relies on it.

Three separate questions, deliberately not collapsed into one boolean:

  * is the document *well formed* -- required fields, known kinds, a schema
    version this code speaks
  * is it *safe* -- nothing secret-shaped anywhere in it
  * is it *still true enough to use* -- verified knowledge has a shelf life,
    and a record nobody has confirmed for months is treated as stale rather
    than as fact
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .evidence import evidence_is_usable, scan_for_secrets
from .models import (
    KnowledgeDocument,
    KnowledgeRecord,
    RecordKind,
    SCHEMA_VERSION,
    TrustLevel,
    read_time,
)

# How long a VERIFIED record stays usable without being re-confirmed.
DEFAULT_MAX_AGE_DAYS = 30

# What each kind of record must carry to mean anything at all.
REQUIRED_PAYLOAD_KEYS: dict[RecordKind, tuple[str, ...]] = {
    RecordKind.INTEGRATION: ("base_url", "auth_type"),
    RecordKind.AUTH: ("login_url",),
    RecordKind.NAVIGATION: ("starting_state", "actions", "expected_result"),
    RecordKind.SELECTOR: ("component", "purpose", "preferred", "selector_type"),
    RecordKind.PROCEDURE: ("steps",),
    RecordKind.POLICY: ("rule", "applies_to"),
    RecordKind.FAILURE: ("observed_error", "likely_cause"),
}


#: Re-exported so callers have one place to read a stamp from.
parse_time = read_time


@dataclass
class ValidationReport:
    """Everything wrong with a document, grouped by how bad it is."""

    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stale: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "problems": list(self.problems),
            "warnings": list(self.warnings),
            "stale": list(self.stale),
        }


def validate_record(record: KnowledgeRecord) -> list[str]:
    """Every reason this record is not well formed. Empty is a pass."""
    problems: list[str] = []
    if record.record_id != KnowledgeRecord.make_id(record.kind, record.name):
        problems.append(
            f"{record.record_id}: id does not match kind/name "
            f"({KnowledgeRecord.make_id(record.kind, record.name)})"
        )
    for missing in REQUIRED_PAYLOAD_KEYS.get(record.kind, ()):  # noqa: PERF203
        if missing not in record.payload:
            problems.append(f"{record.record_id}: payload is missing {missing!r}")
    if not record.tenant or not record.integration or not record.environment:
        problems.append(f"{record.record_id}: tenant/integration/environment incomplete")
    if record.version < 1:
        problems.append(f"{record.record_id}: version must be >= 1")

    # Anything the runtime may use unattended has to be provable.
    if record.trust in (TrustLevel.VERIFIED, TrustLevel.CANDIDATE):
        if not any(evidence_is_usable(e) for e in record.evidence):
            problems.append(
                f"{record.record_id}: {record.trust.value} without usable evidence"
            )
    if record.trust is TrustLevel.VERIFIED:
        distinct = len(set(record.verified_by_runs))
        if distinct < 2:
            problems.append(
                f"{record.record_id}: VERIFIED but only {distinct} distinct "
                "execution(s) vouch for it"
            )
    # Lifecycle fields have to be readable, or the gates that depend on them
    # silently stop gating.
    for stamp in ("expires_at", "approved_at", "last_verified"):
        value = getattr(record, stamp)
        if value and parse_time(value) is None:
            problems.append(f"{record.record_id}: {stamp} is not a readable time")
    if record.approval_required and record.approved_at and not record.approved_by:
        problems.append(f"{record.record_id}: approved without naming an approver")
    if record.superseded_by and record.superseded_by == record.record_id:
        problems.append(f"{record.record_id}: supersedes itself")

    for problem in scan_for_secrets(record.payload, record.record_id):
        problems.append(problem)
    # A record's own notes are free text a run wrote, so screen them too.
    for problem in scan_for_secrets(record.notes, f"{record.record_id}.notes"):
        problems.append(problem)
    return problems


def is_stale(record: KnowledgeRecord, now: datetime,
             max_age_days: int = DEFAULT_MAX_AGE_DAYS) -> bool:
    """True when verified knowledge has gone too long without confirmation."""
    if record.trust is not TrustLevel.VERIFIED:
        return False
    confirmed = parse_time(record.last_verified) or parse_time(record.last_success)
    if confirmed is None:
        return True
    return now - confirmed > timedelta(days=max_age_days)


def validate_document(
    document: KnowledgeDocument,
    *,
    now: datetime | None = None,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
) -> ValidationReport:
    report = ValidationReport()
    if document.schema_version != SCHEMA_VERSION:
        report.problems.append(
            f"schema version {document.schema_version} != {SCHEMA_VERSION}"
        )
    now = now or datetime.now(timezone.utc)

    for record_id, record in sorted(document.records.items()):
        if not record.belongs_to(document.tenant, document.integration,
                                 document.environment):
            report.problems.append(
                f"{record_id}: belongs to another tenant/integration/environment"
            )
        report.problems.extend(validate_record(record))
        if is_stale(record, now, max_age_days):
            report.stale.append(record_id)
        if record.superseded_by and record.superseded_by not in document.records:
            report.problems.append(
                f"{record_id}: superseded by {record.superseded_by}, which is "
                "not in this document"
            )
        if record.trust is TrustLevel.DEGRADED:
            report.warnings.append(f"{record_id}: DEGRADED -- needs rediscovery")
        if record.trust is TrustLevel.INVALID:
            report.warnings.append(f"{record_id}: INVALID -- will not be used")
        if record.awaiting_approval:
            report.warnings.append(f"{record_id}: awaiting approval -- not usable")
        if record.is_expired(now.isoformat()):
            report.stale.append(record_id)

    for raw in document.pending:
        if raw.get("status", "open") == "open":
            report.warnings.append(
                f"{raw.get('record_id', '?')}: a proposed change is waiting for a "
                "decision"
            )
    for problem in scan_for_secrets(document.pending, "pending"):
        report.problems.append(problem)
    # Stale and expired can both name the same record; say it once.
    report.stale = sorted(set(report.stale))
    return report
