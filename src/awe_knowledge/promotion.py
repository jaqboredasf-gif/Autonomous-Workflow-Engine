"""The rules that decide what may be trusted.

The whole point of the trust model is that saying something does not make it
true. So promotion is deliberately hard to reach and demotion is deliberately
easy:

  * an observation starts at DISCOVERED and is never used unattended
  * one success with usable evidence reaches CANDIDATE
  * VERIFIED needs repeated success across *distinct executions* -- the same
    run reporting success twice proves nothing and is refused
  * one failure against VERIFIED drops straight to DEGRADED
  * a second failure, or a confirmed incompatibility, reaches INVALID

Every transition is recorded as a ``TrustChange`` so a run can report exactly
what it learned rather than leaving a diff for someone to notice later.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

from .evidence import evidence_is_usable, redact
from .models import (
    EvidenceRef,
    EvidenceRequired,
    KnowledgeRecord,
    SelectorStatus,
    TrustLevel,
)

# Distinct executions that must succeed before knowledge is used unattended.
VERIFY_THRESHOLD = 2
# Failures against knowledge already in trouble before it is written off.
INVALIDATE_AFTER_FAILURES = 2


@dataclass
class TrustChange:
    """One movement in trust, with the reason that caused it."""

    record_id: str
    before: str
    after: str
    reason: str
    execution_id: str = ""
    at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def is_promotion(self) -> bool:
        order = [
            TrustLevel.INVALID, TrustLevel.DEGRADED, TrustLevel.DISCOVERED,
            TrustLevel.CANDIDATE, TrustLevel.VERIFIED,
        ]
        return order.index(TrustLevel(self.after)) > order.index(TrustLevel(self.before))


def _selector_status_for(trust: TrustLevel) -> str:
    return {
        TrustLevel.DISCOVERED: SelectorStatus.CANDIDATE,
        TrustLevel.CANDIDATE: SelectorStatus.CANDIDATE,
        TrustLevel.VERIFIED: SelectorStatus.VERIFIED,
        TrustLevel.DEGRADED: SelectorStatus.DEGRADED,
        TrustLevel.INVALID: SelectorStatus.INVALID,
    }[trust].value


def _apply(record: KnowledgeRecord, after: TrustLevel, reason: str,
           execution_id: str, at: str) -> TrustChange:
    before = record.trust
    record.trust = after
    record.version += 1
    record.updated_at = at
    if record.kind.value == "selector":
        record.payload["status"] = _selector_status_for(after)
    if after is TrustLevel.VERIFIED:
        record.last_verified = at
        record.remember_good()
    return TrustChange(
        record_id=record.record_id,
        before=before.value,
        after=after.value,
        reason=redact(reason),
        execution_id=execution_id,
        at=at,
    )


#: The one way trust is allowed to move. Exposed so ``lifecycle`` can express
#: expiry and supersession as trust changes rather than as field assignments.
apply_trust = _apply


def record_success(
    record: KnowledgeRecord,
    evidence: EvidenceRef,
    *,
    at: str,
    threshold: int = VERIFY_THRESHOLD,
) -> TrustChange | None:
    """Note that this knowledge worked, and promote it if it has earned it."""
    if not evidence_is_usable(evidence):
        raise EvidenceRequired(
            f"{record.record_id}: a success needs evidence naming an execution "
            "and a time, with an artifact that still exists"
        )
    record.success_count += 1
    record.consecutive_failures = 0
    record.last_failure_execution = ""
    record.last_success = at
    record.updated_at = at
    record.evidence.append(evidence)

    # A record is only ever verified by *distinct* executions. One agent
    # asserting the same thing twice inside one run does not count twice.
    if evidence.execution_id not in record.verified_by_runs:
        record.verified_by_runs.append(evidence.execution_id)
    distinct = len(record.verified_by_runs)

    if record.trust is TrustLevel.INVALID:
        # Written-off knowledge is not resurrected by a passing check; it has
        # to be re-observed deliberately.
        return None
    if record.trust is TrustLevel.VERIFIED:
        record.last_verified = at
        record.remember_good()
        return None
    if distinct >= threshold:
        return _apply(
            record, TrustLevel.VERIFIED,
            f"{distinct} distinct executions succeeded", evidence.execution_id, at,
        )
    if record.trust in (TrustLevel.DISCOVERED, TrustLevel.DEGRADED):
        return _apply(
            record, TrustLevel.CANDIDATE,
            "succeeded once with evidence", evidence.execution_id, at,
        )
    return None


def record_failure(
    record: KnowledgeRecord,
    reason: str,
    *,
    at: str,
    execution_id: str = "",
    confirmed_incompatible: bool = False,
) -> TrustChange | None:
    """Note that this knowledge did not work, and lower it accordingly."""
    record.failure_count += 1
    # A run that tries the stored value, fails, rediscovers and fails again has
    # produced one opinion, not two. Only a *different* execution failing moves
    # a record closer to being written off.
    if not execution_id or execution_id != record.last_failure_execution:
        record.consecutive_failures += 1
    record.last_failure_execution = execution_id
    record.last_failure = at
    record.updated_at = at

    if confirmed_incompatible:
        return _apply(record, TrustLevel.INVALID,
                      f"confirmed incompatible: {reason}", execution_id, at)
    if record.trust is TrustLevel.INVALID:
        return None
    if record.trust is TrustLevel.DEGRADED:
        if record.consecutive_failures >= INVALIDATE_AFTER_FAILURES:
            return _apply(record, TrustLevel.INVALID,
                          f"failed {record.consecutive_failures} times running: {reason}",
                          execution_id, at)
        return None
    if record.trust in (TrustLevel.VERIFIED, TrustLevel.CANDIDATE):
        # Re-verification starts from scratch: the runs that vouched for this
        # no longer vouch for it.
        record.verified_by_runs = []
        return _apply(record, TrustLevel.DEGRADED, reason, execution_id, at)
    return None


def confirm_invalid(record: KnowledgeRecord, reason: str, *, at: str,
                    execution_id: str = "") -> TrustChange:
    """Write knowledge off deliberately, by hand or on confirmed evidence."""
    return _apply(record, TrustLevel.INVALID, reason, execution_id, at)


def observe(record: KnowledgeRecord, reason: str, *, at: str,
            execution_id: str = "") -> TrustChange | None:
    """Re-open written-off knowledge as a fresh, untrusted observation."""
    if record.trust is not TrustLevel.INVALID:
        return None
    record.verified_by_runs = []
    record.consecutive_failures = 0
    return _apply(record, TrustLevel.DISCOVERED, reason, execution_id, at)
