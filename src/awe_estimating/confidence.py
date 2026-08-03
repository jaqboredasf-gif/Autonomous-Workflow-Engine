"""How much to trust an estimate, and why -- computed, not felt.

A confidence score with no reasons is decoration. Somebody reads "medium" and
learns nothing they can act on. So this module never returns a level without
the list of findings that produced it, and the reasons are phrased as things a
person could go and fix.

## Deterministic on purpose

Nothing here samples, weighs by intuition, or asks a model. Confidence is a
function of countable facts about the estimate:

  * how much of the scope could actually be priced;
  * how many questions are still open, and whether they block pricing;
  * how many assumptions rest on nothing that may price;
  * whether the rate card was a template;
  * how wide the range is.

The same estimate always scores the same, which is what lets a threshold mean
something. A confidence that drifts run to run cannot gate an approval.

## The thresholds are configuration, not opinion

:class:`ConfidenceRules` carries them, and the defaults are stated in one place
so a business that prices differently can move them without touching code. They
are defaults, not truths -- see :attr:`ConfidenceRules.source`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .model import Confidence, Estimate

ZERO = Decimal("0")


@dataclass(frozen=True)
class ConfidenceRules:
    """Where the lines are drawn. Overridable from configuration."""

    #: Fraction of work scope that must be priceable for each level.
    high_priced_fraction: Decimal = Decimal("0.90")
    medium_priced_fraction: Decimal = Decimal("0.60")
    low_priced_fraction: Decimal = Decimal("0.25")

    #: An estimate with more open questions than this cannot be HIGH.
    high_max_open_questions: int = 0
    medium_max_open_questions: int = 3

    #: A range wider than this (high/low) cannot be HIGH.
    high_max_range_spread: Decimal = Decimal("1.6")

    source: str = "built-in defaults (nobody has confirmed these)"

    @classmethod
    def from_mapping(
        cls, data: dict[str, Any] | None, *, source: str = ""
    ) -> "ConfidenceRules":
        data = dict(data or {})
        if not data:
            return cls()
        def number(key: str, fallback: Decimal) -> Decimal:
            return Decimal(str(data[key])) if key in data else fallback
        base = cls()
        return cls(
            high_priced_fraction=number("high_priced_fraction",
                                        base.high_priced_fraction),
            medium_priced_fraction=number("medium_priced_fraction",
                                          base.medium_priced_fraction),
            low_priced_fraction=number("low_priced_fraction",
                                       base.low_priced_fraction),
            high_max_open_questions=int(
                data.get("high_max_open_questions", base.high_max_open_questions)),
            medium_max_open_questions=int(
                data.get("medium_max_open_questions", base.medium_max_open_questions)),
            high_max_range_spread=number("high_max_range_spread",
                                         base.high_max_range_spread),
            source=source or "configuration",
        )

    def describe(self) -> list[str]:
        return [
            f"HIGH needs {self.high_priced_fraction:.0%} of scope priced, "
            f"at most {self.high_max_open_questions} open question(s), and a "
            f"range no wider than {self.high_max_range_spread}x",
            f"MEDIUM needs {self.medium_priced_fraction:.0%} priced and at most "
            f"{self.medium_max_open_questions} open question(s)",
            f"LOW needs {self.low_priced_fraction:.0%} priced",
            f"source: {self.source}",
        ]


DEFAULT_RULES = ConfidenceRules()


@dataclass
class ConfidenceReport:
    """A level, the reasons for it, and the numbers behind them."""

    level: Confidence = Confidence.INSUFFICIENT
    reasons: list[str] = field(default_factory=list)
    priced_fraction: Decimal = ZERO
    open_questions: int = 0
    blocking_questions: int = 0
    unconfirmed_assumptions: int = 0
    range_spread: Decimal = Decimal("1")
    rules: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level.value,
            "reasons": list(self.reasons),
            "priced_fraction": str(self.priced_fraction.quantize(Decimal("0.01"))),
            "open_questions": self.open_questions,
            "blocking_questions": self.blocking_questions,
            "unconfirmed_assumptions": self.unconfirmed_assumptions,
            "range_spread": str(self.range_spread.quantize(Decimal("0.01"))),
            "rules": list(self.rules),
        }


def assess(
    estimate: Estimate, rules: ConfidenceRules = DEFAULT_RULES
) -> ConfidenceReport:
    """Score an estimate, and say what would improve it.

    Every reason is written so a person can act on it. "60% of the work could
    be priced" tells them nothing; "3 items could not be priced -- see the open
    questions" tells them where to look.
    """
    work = estimate.work_scope
    priceable = [item for item in work if item.priceable]
    excluded = [item for item in work if item.excluded_reason]
    considered = [item for item in work if not item.excluded_reason]

    fraction = (
        Decimal(len(priceable)) / Decimal(len(considered))
        if considered else ZERO
    )
    questions = estimate.open_questions
    blocking = [q for q in questions if q.blocks_pricing]
    unconfirmed = estimate.unconfirmed_assumptions

    low, base, high = estimate.range
    spread = (high / low) if low > ZERO else Decimal("1")

    report = ConfidenceReport(
        priced_fraction=fraction,
        open_questions=len(questions),
        blocking_questions=len(blocking),
        unconfirmed_assumptions=len(unconfirmed),
        range_spread=spread,
        rules=rules.describe(),
    )

    reasons: list[str] = []

    if not considered:
        report.level = Confidence.INSUFFICIENT
        reasons.append(
            "there is nothing to price: every item was excluded or none was found"
            if work else "no scope was produced at all"
        )
        report.reasons = reasons
        return report

    unpriced = len(considered) - len(priceable)
    if unpriced:
        reasons.append(
            f"{unpriced} of {len(considered)} item(s) could not be priced -- "
            "each says why on its own line"
        )
    if blocking:
        reasons.append(
            f"{len(blocking)} question(s) must be answered before those items "
            "can be priced"
        )
    other_questions = len(questions) - len(blocking)
    if other_questions:
        reasons.append(
            f"{other_questions} further question(s) would change the price if "
            "answered differently"
        )
    if unconfirmed:
        reasons.append(
            f"{len(unconfirmed)} assumption(s) rest on nothing that can price "
            "them, and need somebody to confirm or replace them"
        )
    if excluded:
        reasons.append(
            f"{len(excluded)} item(s) were deliberately excluded and are not in "
            "the total"
        )
    if any("template" in w for w in estimate.warnings):
        reasons.append(
            "the rate card is a template, so the figures are illustrative "
            "rather than this business's prices"
        )
    if spread > rules.high_max_range_spread:
        reasons.append(
            f"the range is {spread:.1f} times wider at the top than the bottom, "
            "which is a wide spread to quote against"
        )

    report.level = _level(fraction, questions, blocking, spread, rules, estimate)
    if report.level is Confidence.HIGH and not reasons:
        reasons.append(
            "every item was priced from the rate card with no open questions"
        )
    report.reasons = reasons
    return report


def _level(
    fraction: Decimal,
    questions: list[Any],
    blocking: list[Any],
    spread: Decimal,
    rules: ConfidenceRules,
    estimate: Estimate,
) -> Confidence:
    template = any("template" in w for w in estimate.warnings)

    if (
        fraction >= rules.high_priced_fraction
        and len(questions) <= rules.high_max_open_questions
        and spread <= rules.high_max_range_spread
        and not template
    ):
        return Confidence.HIGH
    if (
        fraction >= rules.medium_priced_fraction
        and len(blocking) == 0
        and len(questions) <= rules.medium_max_open_questions
    ):
        return Confidence.MEDIUM
    if fraction >= rules.low_priced_fraction:
        return Confidence.LOW
    return Confidence.INSUFFICIENT


def apply(estimate: Estimate, rules: ConfidenceRules = DEFAULT_RULES) -> ConfidenceReport:
    """Score the estimate and record the result on it."""
    report = assess(estimate, rules)
    estimate.confidence = report.level
    estimate.confidence_reasons = list(report.reasons)
    return report
