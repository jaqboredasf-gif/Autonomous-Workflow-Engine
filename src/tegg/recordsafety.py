"""Which live site-visit records automation may write to, and which it may not.

Enumeration alone is not enough to start a live run. Before anything writes to
a record, something has to answer a narrower question: is this row a real
customer's finished work?

The rule this module enforces is deliberately one-directional. A record is
writable only if it is *positively identified* as safe. Anything unrecognised,
ambiguous, or blank is refused. That asymmetry is the whole design: the cost of
wrongly refusing a usable test record is a message asking for a better one; the
cost of wrongly accepting a completed customer record is corrupting delivered
work.

Nothing here contacts the portal. It classifies text that enumeration already
read, so every rule is testable without credentials.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --- classifications -------------------------------------------------------
DRAFT = "Draft"
IN_PROGRESS = "In Progress"
COMPLETED = "Completed"
TEST = "Test/Sandbox"
UNKNOWN = "Unknown"

# Matched against the Status column, lowercased and stripped.
#
# "Incomplete" is the trap: it contains "complete" as a substring, so these are
# matched as whole values rather than by containment. Getting that backwards
# would classify unfinished work as finished.
COMPLETED_VALUES = frozenset({"completed", "complete", "closed", "finished"})
DRAFT_VALUES = frozenset({"draft", "new", "not started", "unsubmitted", "pending"})
IN_PROGRESS_VALUES = frozenset(
    {"in progress", "in-progress", "incomplete", "open", "started", "active"}
)

# A record is only Test/Sandbox if it *says so*. These are matched against the
# customer, site and identifier, not the status, because the portal has no
# sandbox status -- a test record is one a human deliberately named as one.
TEST_MARKERS = (
    r"\btest\b",
    r"\bsandbox\b",
    r"\bdemo\b",
    r"\bdo\s*not\s*use\b",
    r"\btraining\b",
    r"\bautomation\b",
    r"\bqa\b",
    r"\bzz+[-_ ]",
)
_TEST_PATTERN = re.compile("|".join(TEST_MARKERS), re.IGNORECASE)


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def classify_status(status: str) -> str:
    """Map one Status cell to a classification.

    Whole-value matching only. An unrecognised status is ``UNKNOWN`` rather
    than a guess, because a guess here decides whether something gets written.
    """
    value = _norm(status)
    if not value:
        return UNKNOWN
    if value in COMPLETED_VALUES:
        return COMPLETED
    if value in DRAFT_VALUES:
        return DRAFT
    if value in IN_PROGRESS_VALUES:
        return IN_PROGRESS
    return UNKNOWN


def looks_like_a_test_record(*fields: str) -> bool:
    """Whether any field positively announces itself as a test record."""
    return any(_TEST_PATTERN.search(str(f or "")) for f in fields)


def classify(visit) -> str:
    """Classify one enumerated site visit.

    A record named as a test record is reported as ``TEST`` whatever its
    status -- except when it is Completed. A finished record is finished, and
    calling it a sandbox does not make it writable.
    """
    status = classify_status(getattr(visit, "status", ""))
    if status == COMPLETED:
        return COMPLETED
    if looks_like_a_test_record(
        getattr(visit, "customer", ""),
        getattr(visit, "site", ""),
        getattr(visit, "identifier", ""),
        getattr(visit, "label", ""),
    ):
        return TEST
    return status


@dataclass
class Verdict:
    """Whether one record may be written to, and why."""

    identifier: str
    classification: str
    writable: bool
    reason: str

    def to_dict(self) -> dict:
        return {
            "identifier": self.identifier,
            "classification": self.classification,
            "writable": self.writable,
            "reason": self.reason,
        }

    def __str__(self) -> str:
        mark = "WRITABLE" if self.writable else "READ-ONLY"
        return f"[{mark:<9}] {self.identifier or '?':<14} {self.classification:<13} {self.reason}"


def assess(visit) -> Verdict:
    """Decide whether automation may write to this record.

    Only a record positively identified as a test/sandbox record is writable.
    Draft and In Progress records are refused too: they are unfinished *real*
    customer work, which is not the same thing as a record set aside for
    automation.
    """
    identifier = str(getattr(visit, "identifier", "") or "")
    classification = classify(visit)

    if classification == COMPLETED:
        return Verdict(
            identifier,
            classification,
            False,
            "a completed customer report; writing to it would alter delivered work",
        )
    if classification == TEST:
        return Verdict(
            identifier,
            classification,
            True,
            "named as a test/sandbox record, so it is safe to drive end to end",
        )
    if classification in (DRAFT, IN_PROGRESS):
        return Verdict(
            identifier,
            classification,
            False,
            f"unfinished real customer work ({classification}); not a record set "
            "aside for automation",
        )
    return Verdict(
        identifier,
        classification,
        False,
        f"status {str(getattr(visit, 'status', '') or '(blank)')!r} is not "
        "recognised; refusing rather than guessing",
    )


@dataclass
class Survey:
    """Every enumerated record, classified, and what it means for a live run."""

    verdicts: list[Verdict]

    def counts(self) -> dict[str, int]:
        tally: dict[str, int] = {}
        for verdict in self.verdicts:
            tally[verdict.classification] = tally.get(verdict.classification, 0) + 1
        return tally

    @property
    def writable(self) -> list[Verdict]:
        return [v for v in self.verdicts if v.writable]

    @property
    def safest(self) -> Verdict | None:
        """The record a live run should use, or None if there is not one."""
        return self.writable[0] if self.writable else None

    def to_dict(self) -> dict:
        safest = self.safest
        return {
            "total": len(self.verdicts),
            "counts": self.counts(),
            "writable": [v.identifier for v in self.writable],
            "safest": safest.identifier if safest else None,
            "verdicts": [v.to_dict() for v in self.verdicts],
        }


def survey(visits) -> Survey:
    return Survey([assess(v) for v in visits])
