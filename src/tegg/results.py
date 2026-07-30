"""The structured result of trying to produce one report, and of a whole run.

Three separate statuses are tracked per report, because collapsing them is how
an unsigned certificate ends up in a folder called FINAL:

  ``generation_status``   did the document get produced at all
  ``review_status``       can a machine sign this off, or must a human look
  ``finalization_status``  may this be labelled final, and if not, why not

A document can be generated perfectly and still be ``finalization_status:
blocked``. That is not a failure of the automation; it is the automation
declining to make a claim it cannot support. :func:`ReportResult.consistent`
enforces that a result never claims to be final while review is outstanding, so
the honesty rule is checked by code rather than trusted to a reviewer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# generation_status
NOT_ATTEMPTED = "not_attempted"
COMPLETED = "completed"
FAILED = "failed"
SKIPPED = "skipped"

# review_status
AUTOMATED = "automated"
HUMAN_REVIEW_REQUIRED = "human_review_required"

# finalization_status
READY = "ready"
BLOCKED = "blocked"

# export_status / validation_status
PASSED = "passed"
NOT_APPLICABLE = "not_applicable"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class ReportResult:
    """Everything known about one attempt at one report section."""

    report_id: str
    canonical_type: str = ""
    input_fixture: str = ""
    template_selected: str = ""
    expected_template: str = ""

    generation_status: str = NOT_ATTEMPTED
    export_status: str = NOT_ATTEMPTED
    validation_status: str = NOT_ATTEMPTED
    review_status: str = AUTOMATED
    finalization_status: str = READY

    missing_fields: list[str] = field(default_factory=list)
    formatting_defects: list[str] = field(default_factory=list)
    human_review: list[str] = field(default_factory=list)
    blocker: str = ""
    failure_reason: str = ""
    root_cause: str = ""
    # For a fault case: the failure that was deliberately provoked and correctly
    # detected. Kept separate from failure_reason so a successful detection does
    # not read as a broken run, while still recording exactly what happened.
    detected_failure: str = ""

    artifacts: list[str] = field(default_factory=list)
    checks: list[dict] = field(default_factory=list)
    attempts: int = 0
    duration_ms: int = 0

    @property
    def ok(self) -> bool:
        """Whether this section may be used in an assembled report.

        Human review being required does not make a section unusable -- it makes
        the *report* a draft. Generation and validation passing is what matters
        here.
        """
        return (
            self.generation_status == COMPLETED
            and self.validation_status == PASSED
            and not self.failure_reason
        )

    def require_human_review(self, reason: str) -> None:
        self.review_status = HUMAN_REVIEW_REQUIRED
        if reason not in self.human_review:
            self.human_review.append(reason)

    def block_finalization(self, blocker: str) -> None:
        self.finalization_status = BLOCKED
        self.blocker = blocker
        self.require_human_review(blocker)

    def fail(self, reason: str, *, root_cause: str = "") -> None:
        self.generation_status = FAILED
        self.failure_reason = reason
        if root_cause:
            self.root_cause = root_cause

    def consistent(self) -> list[str]:
        """Contradictions in this result. Empty means it can be trusted.

        This is the guard against the one mistake that matters most: a report
        described as ready to finalize while something still needs a human.
        """
        problems = []
        if self.finalization_status == READY and (
            self.review_status == HUMAN_REVIEW_REQUIRED or self.human_review
        ):
            problems.append(
                f"{self.report_id}: finalization_status is {READY!r} while review "
                f"is still outstanding ({'; '.join(self.human_review) or 'unstated'})"
            )
        if self.finalization_status == BLOCKED and not self.blocker:
            problems.append(
                f"{self.report_id}: finalization is blocked but no blocker is named"
            )
        if self.generation_status == FAILED and not self.failure_reason:
            problems.append(
                f"{self.report_id}: generation failed but no reason is recorded"
            )
        if self.generation_status == COMPLETED and self.failure_reason:
            problems.append(
                f"{self.report_id}: generation is {COMPLETED!r} but a failure "
                f"reason is recorded ({self.failure_reason})"
            )
        return problems

    def to_dict(self) -> dict[str, Any]:
        return {
            "report_id": self.report_id,
            "canonical_type": self.canonical_type,
            "input_fixture": self.input_fixture,
            "template_selected": self.template_selected,
            "expected_template": self.expected_template,
            "generation_status": self.generation_status,
            "export_status": self.export_status,
            "validation_status": self.validation_status,
            "review_status": self.review_status,
            "finalization_status": self.finalization_status,
            "missing_fields": list(self.missing_fields),
            "formatting_defects": list(self.formatting_defects),
            "human_review": list(self.human_review),
            "blocker": self.blocker,
            "failure_reason": self.failure_reason,
            "root_cause": self.root_cause,
            "detected_failure": self.detected_failure,
            "artifacts": list(self.artifacts),
            "checks": list(self.checks),
            "attempts": self.attempts,
            "duration_ms": self.duration_ms,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReportResult":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class RunReport:
    """The result of one whole mock run, and whether it is acceptable."""

    started_at: str = field(default_factory=utcnow)
    finished_at: str = ""
    mode: str = "mock"
    portal_url: str = ""
    job_id: str = ""
    results: list[ReportResult] = field(default_factory=list)
    acceptance: dict[str, Any] = field(default_factory=dict)
    assembled: str = ""
    assembled_pages: int = 0
    notes: list[str] = field(default_factory=list)

    def add(self, result: ReportResult) -> ReportResult:
        self.results.append(result)
        return result

    def by_id(self, report_id: str) -> ReportResult | None:
        for result in self.results:
            if result.report_id == report_id:
                return result
        return None

    @property
    def failures(self) -> list[ReportResult]:
        return [r for r in self.results if not r.ok]

    @property
    def human_review_required(self) -> list[ReportResult]:
        return [r for r in self.results if r.review_status == HUMAN_REVIEW_REQUIRED]

    @property
    def blocked(self) -> list[ReportResult]:
        return [r for r in self.results if r.finalization_status == BLOCKED]

    def inconsistencies(self) -> list[str]:
        problems: list[str] = []
        for result in self.results:
            problems.extend(result.consistent())
        return problems

    def counts(self) -> dict[str, int]:
        return {
            "total": len(self.results),
            "passed": len([r for r in self.results if r.ok]),
            "failed": len(self.failures),
            "human_review_required": len(self.human_review_required),
            "finalization_blocked": len(self.blocked),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at or utcnow(),
            "mode": self.mode,
            "portal_url": self.portal_url,
            "job_id": self.job_id,
            "counts": self.counts(),
            "acceptance": dict(self.acceptance),
            "assembled": self.assembled,
            "assembled_pages": self.assembled_pages,
            "inconsistencies": self.inconsistencies(),
            "notes": list(self.notes),
            "results": [r.to_dict() for r in self.results],
        }

    def write(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2) + "\n", encoding="utf-8")
        return path
