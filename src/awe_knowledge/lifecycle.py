"""What happens to knowledge after it is written down.

``promotion`` moves a record up and down the trust scale. This module covers
the four things trust alone cannot express:

  * **supersession** -- a newer record replaces an older one, and the older
    one is kept, marked, and never silently deleted
  * **contradiction** -- a run observed something that disagrees with what is
    already VERIFIED. That is not a promotion and not a failure; it is a
    question, and it is queued rather than applied
  * **expiry** -- knowledge with a shelf life stops being usable on its own
    schedule, before anyone notices it went wrong
  * **approval** -- some records may never be used unattended until a person
    says so, whatever the evidence says

The bias throughout: a run may *propose* anything and may *confirm* what is
already believed, but it may not quietly overwrite a verified fact.
"""

from __future__ import annotations

import copy
from dataclasses import asdict, dataclass, field
from typing import Any

from .evidence import redact
from .models import (
    EvidenceRef,
    KnowledgeDocument,
    KnowledgeRecord,
    RecordKind,
    TrustLevel,
)
from .promotion import TrustChange, apply_trust

#: Kinds a run may never promote by itself. A policy is somebody's decision,
#: not an observation, so no amount of successful execution makes one true.
APPROVAL_REQUIRED_KINDS = (RecordKind.POLICY,)


@dataclass
class Contradiction:
    """A run saw something that disagrees with knowledge already trusted."""

    record_id: str
    field: str
    believed: Any
    observed: Any
    execution_id: str = ""
    at: str = ""
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        raw = asdict(self)
        raw["note"] = redact(str(raw.get("note", "")))
        return raw


@dataclass
class PendingChange:
    """A proposed change held back for approval, with why it was held."""

    record_id: str
    kind: str
    reason: str
    proposed_payload: dict[str, Any] = field(default_factory=dict)
    contradictions: list[dict[str, Any]] = field(default_factory=list)
    execution_id: str = ""
    at: str = ""
    evidence: list[dict[str, Any]] = field(default_factory=list)
    status: str = "open"          # open | approved | rejected
    decided_by: str = ""
    decided_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "PendingChange":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known})


# -- contradiction --------------------------------------------------------
def find_contradictions(
    record: KnowledgeRecord,
    observed_payload: dict[str, Any],
    *,
    execution_id: str = "",
    at: str = "",
) -> list[Contradiction]:
    """Where an observation disagrees with what a record already claims.

    Only keys the record already holds are compared. A run adding a *new*
    key is enriching the record, not contradicting it.
    """
    found: list[Contradiction] = []
    for key, believed in record.payload.items():
        if key not in observed_payload:
            continue
        if observed_payload[key] != believed:
            found.append(
                Contradiction(
                    record_id=record.record_id,
                    field=key,
                    believed=believed,
                    observed=observed_payload[key],
                    execution_id=execution_id,
                    at=at,
                )
            )
    return found


def propose_change(
    document: KnowledgeDocument,
    record: KnowledgeRecord,
    observed_payload: dict[str, Any],
    *,
    reason: str,
    at: str,
    execution_id: str = "",
    evidence: EvidenceRef | None = None,
) -> tuple[PendingChange | None, list[Contradiction]]:
    """Apply an observed payload, or queue it if it may not be applied.

    Applied directly when the record is not yet trusted -- refining a
    hypothesis is what a hypothesis is for. Queued when the record is
    VERIFIED and the observation disagrees with it, and whenever the kind
    needs sign-off. Returns ``(pending_or_None, contradictions)``.
    """
    contradictions = find_contradictions(
        record, observed_payload, execution_id=execution_id, at=at
    )
    needs_approval = (
        record.kind in APPROVAL_REQUIRED_KINDS
        or record.approval_required
        or (record.trust is TrustLevel.VERIFIED and bool(contradictions))
    )
    if not needs_approval:
        record.payload.update(copy.deepcopy(observed_payload))
        record.version += 1
        record.updated_at = at
        return None, contradictions

    pending = PendingChange(
        record_id=record.record_id,
        kind=record.kind.value,
        reason=redact(reason),
        proposed_payload=copy.deepcopy(observed_payload),
        contradictions=[c.to_dict() for c in contradictions],
        execution_id=execution_id,
        at=at,
        evidence=[evidence.to_dict()] if evidence else [],
    )
    document.pending.append(pending.to_dict())
    return pending, contradictions


def open_pending(document: KnowledgeDocument) -> list[PendingChange]:
    return [
        PendingChange.from_dict(p)
        for p in document.pending
        if p.get("status", "open") == "open"
    ]


def decide_pending(
    document: KnowledgeDocument,
    record_id: str,
    *,
    approve: bool,
    decided_by: str,
    at: str,
) -> list[TrustChange]:
    """Approve or reject every open proposal against one record.

    Approval applies the payload and stamps who said so; it does **not**
    promote the record. Earning trust is still the promotion module's job,
    and still needs distinct successful executions.
    """
    changes: list[TrustChange] = []
    record = document.get(record_id)
    for raw in document.pending:
        if raw.get("record_id") != record_id or raw.get("status", "open") != "open":
            continue
        raw["status"] = "approved" if approve else "rejected"
        raw["decided_by"] = decided_by
        raw["decided_at"] = at
        if not approve or record is None:
            continue
        record.remember_good()
        record.payload.update(copy.deepcopy(raw.get("proposed_payload", {})))
        record.approved_by = decided_by
        record.approved_at = at
        record.version += 1
        record.updated_at = at
        # A payload that changed under a verified record is no longer the
        # thing that was verified. It goes back to being a hypothesis.
        if record.trust is TrustLevel.VERIFIED and raw.get("contradictions"):
            record.verified_by_runs = []
            changes.append(
                apply_trust(
                    record,
                    TrustLevel.CANDIDATE,
                    f"payload changed under approval by {decided_by}",
                    raw.get("execution_id", ""),
                    at,
                )
            )
    return changes


# -- supersession ---------------------------------------------------------
def supersede(
    document: KnowledgeDocument,
    old_id: str,
    new_record: KnowledgeRecord,
    *,
    reason: str,
    at: str,
    execution_id: str = "",
) -> TrustChange | None:
    """Replace one record with another, keeping the old one on the record."""
    old = document.get(old_id)
    document.put(new_record)
    if old is None:
        return None
    old.superseded_by = new_record.record_id
    new_record.supersedes = old_id
    new_record.updated_at = at
    if old.trust is TrustLevel.INVALID:
        old.updated_at = at
        return None
    return apply_trust(
        old, TrustLevel.INVALID,
        f"superseded by {new_record.record_id}: {reason}", execution_id, at,
    )


# -- expiry ---------------------------------------------------------------
def expire(
    document: KnowledgeDocument,
    *,
    now_iso: str,
    reason: str = "expired",
) -> list[TrustChange]:
    """Demote every record whose hard expiry has passed.

    Expiry is a demotion to CANDIDATE, not an invalidation: the knowledge is
    not known to be wrong, it is only no longer known to be right. The next
    successful run re-earns VERIFIED through the normal threshold.
    """
    changes: list[TrustChange] = []
    for record in sorted(document.records.values(), key=lambda r: r.record_id):
        if record.trust is not TrustLevel.VERIFIED:
            continue
        if not record.is_expired(now_iso):
            continue
        record.remember_good()
        record.verified_by_runs = []
        record.expires_at = ""
        changes.append(
            apply_trust(record, TrustLevel.CANDIDATE, reason, "", now_iso)
        )
    return changes
