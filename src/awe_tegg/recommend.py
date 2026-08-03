"""Turning findings into repair recommendations, without inventing any.

The temptation here is to have a model write repair advice. That would be
wrong, and not for a squeamish reason: **the advice already exists**. A TEGG
inspection is performed by a licensed technician who, for every problem they
record, writes what they recommend under "Recommendations For Repair", ticks
whether the equipment should be repaired or replaced, ticks what happens if
nobody does it, and ticks whether an estimate is required. A generated
sentence would be a paraphrase of a professional's judgement, presented with
the same confidence and none of the liability.

So what this module does is narrower and more useful:

  * it **carries the technician's words through** verbatim, with a citation;
  * it **derives** only what is arithmetic or a stated rule -- the work type,
    whether the text says a shutdown is needed, and how urgent the item is
    given the severity, the consequences ticked and whether it was already
    fixed;
  * it says, for every derived field, which rule fired.

Everything it produces is a **draft for a person to check**. Nothing here is
an approval, a quotation, or a commitment.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from .findings import Finding, FindingSet, SourceRef

RECOMMENDATIONS_SCHEMA_VERSION = 1

#: Wording that means the repair needs the equipment de-energised. Taken from
#: the technicians' own vocabulary in live reports, not invented.
DEFAULT_SHUTDOWN_WORDS = (
    r"shut\s?down", r"shutdown", r"de-?energi[sz]e", r"outage", r"power\s+down",
)

#: Consequences that make an item a safety matter rather than a maintenance one.
DEFAULT_SAFETY_CONSEQUENCES = ("Fire Hazard", "Safety Hazard")

#: Severities that go straight to the top of the list without needing a
#: consequence ticked as well.
DEFAULT_IMMEDIATE_SEVERITIES = ("Critical", "Severe")

URGENCY_ORDER = ("immediate", "high", "scheduled", "monitor", "closed")


@dataclass(frozen=True)
class Policy:
    """The judgement calls, in one place, so they are somebody's decision.

    Three questions this module cannot answer for a business:

      * which recorded consequences make an item a **safety** matter rather
        than a maintenance one;
      * which severities are urgent **on their own**, without a consequence;
      * what wording in a technician's repair text means the work needs an
        **outage**.

    The defaults are the ones this tool has always used, and they are
    defensible. They are not, however, anybody's stated policy -- they were
    inferred from reading live reports. So they live here, overridable from the
    service file, and the review output names which ones were in force.

    See ``policy:`` in ``config/service.yaml``.
    """

    safety_consequences: tuple[str, ...] = DEFAULT_SAFETY_CONSEQUENCES
    immediate_severities: tuple[str, ...] = DEFAULT_IMMEDIATE_SEVERITIES
    shutdown_words: tuple[str, ...] = DEFAULT_SHUTDOWN_WORDS
    source: str = "built-in defaults (nobody has confirmed these)"

    @classmethod
    def from_mapping(cls, data: dict[str, Any] | None, *, source: str = "") -> "Policy":
        data = dict(data or {})
        if not data:
            return cls()
        return cls(
            safety_consequences=tuple(
                data.get("safety_consequences") or DEFAULT_SAFETY_CONSEQUENCES
            ),
            immediate_severities=tuple(
                data.get("immediate_severities") or DEFAULT_IMMEDIATE_SEVERITIES
            ),
            shutdown_words=tuple(
                data.get("shutdown_words") or DEFAULT_SHUTDOWN_WORDS
            ),
            source=source or "config",
        )

    @property
    def shutdown_pattern(self) -> re.Pattern[str]:
        joined = "|".join(self.shutdown_words)
        return re.compile(rf"\b({joined})\b", re.IGNORECASE)

    def describe(self) -> list[str]:
        return [
            f"safety consequences: {', '.join(self.safety_consequences)}",
            f"urgent on severity alone: {', '.join(self.immediate_severities)}",
            f"outage wording: {', '.join(self.shutdown_words)}",
            f"source: {self.source}",
        ]


DEFAULT_POLICY = Policy()

#: Kept for anything importing the old names.
SHUTDOWN_WORDS = DEFAULT_POLICY.shutdown_pattern
SAFETY_CONSEQUENCES = DEFAULT_SAFETY_CONSEQUENCES


@dataclass
class Recommendation:
    """One recommended repair, and the reason every part of it says what it does."""

    finding_id: str = ""
    tag_id: str = ""
    customer_id: str = ""
    equipment_type: str = ""
    location: str = ""
    #: "repair", "replace", "repair and replace", or "" when the report ticked
    #: neither box -- which is a real state and is left visible.
    work_type: str = ""
    #: The technician's own words. Never rewritten.
    technician_recommendation: list[str] = field(default_factory=list)
    problem_description: str = ""
    severity: str = ""
    urgency: str = ""
    requires_shutdown: bool | None = None
    consequences: list[str] = field(default_factory=list)
    already_corrected: bool = False
    estimate_required: bool = False
    #: Why each derived field is what it is, in one line each.
    rationale: list[str] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    review_required: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RecommendationSet:
    schema_version: int = RECOMMENDATIONS_SCHEMA_VERSION
    site_visit: str = ""
    recommendations: list[Recommendation] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: The judgement calls in force for this run, and where they came from.
    #: Carried in the output so a reader can see them without reading the code.
    policy: list[str] = field(default_factory=list)
    #: Said in the data, not only in the covering note, so a consumer that only
    #: reads JSON cannot miss it.
    disclaimer: str = (
        "DRAFT. Every line is derived from the inspection reports named in its "
        "evidence and must be checked by a qualified person before it is quoted, "
        "scheduled or sent to a customer."
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "site_visit": self.site_visit,
            "disclaimer": self.disclaimer,
            "policy": list(self.policy),
            "recommendations": [r.to_dict() for r in self.recommendations],
            "warnings": list(self.warnings),
            "counts": {
                "recommendations": len(self.recommendations),
                "needing_estimate": len(
                    [r for r in self.recommendations if r.estimate_required]
                ),
                "safety_related": len(
                    [r for r in self.recommendations
                     if set(r.consequences) & set(DEFAULT_SAFETY_CONSEQUENCES)]
                ),
            },
        }


def work_type_of(finding: Finding) -> tuple[str, str]:
    """Repair, replace, both, or neither -- and the box that decided it."""
    repair = bool(finding.recommendation.get("Repair Equipment"))
    replace = bool(finding.recommendation.get("Replace Equipment"))
    if repair and replace:
        return "repair and replace", "both boxes are ticked on the report"
    if replace:
        return "replace", "'Replace Equipment' is ticked on the report"
    if repair:
        return "repair", "'Repair Equipment' is ticked on the report"
    return "", "neither 'Repair Equipment' nor 'Replace Equipment' is ticked"


def urgency_of(finding: Finding, policy: Policy = DEFAULT_POLICY) -> tuple[str, str]:
    """How soon this needs attention, by a stated rule rather than a feeling.

    The rule, in order, first match wins:

      1. already corrected on the visit                       -> closed
      2. 'Immediate Hazard' or 'Customer Notified Immediately' -> immediate
      3. severity Critical or Severe                           -> immediate
      4. a fire or safety consequence is ticked                -> high
      5. any other consequence is ticked                       -> scheduled
      6. nothing else                                          -> monitor
    """
    if finding.problem_corrected:
        return "closed", "the report records the problem as corrected on the visit"
    if any(finding.urgency.values()):
        ticked = [k for k, v in finding.urgency.items() if v]
        return "immediate", f"the report ticks {', '.join(ticked)}"
    if finding.severity in policy.immediate_severities:
        return "immediate", f"the report grades this problem {finding.severity}"
    safety = [c for c in finding.ticked_consequences
              if c in policy.safety_consequences]
    if safety:
        return "high", f"the report ticks {' and '.join(safety)} as a consequence"
    if finding.ticked_consequences:
        return (
            "scheduled",
            f"the report ticks {', '.join(finding.ticked_consequences)} as a consequence",
        )
    return "monitor", "the report ticks no consequence for leaving this uncorrected"


def shutdown_needed(
    finding: Finding, policy: Policy = DEFAULT_POLICY
) -> tuple[bool | None, str]:
    """Whether the recorded repair text says the work needs an outage."""
    text = " ".join(finding.narrative)
    if not text.strip():
        return None, "no repair text was recorded, so this cannot be judged"
    match = policy.shutdown_pattern.search(text)
    if match:
        return True, f"the repair text says {match.group(0)!r}"
    return False, "the repair text does not mention a shutdown or de-energising"


def recommend(
    findings: FindingSet, policy: Policy = DEFAULT_POLICY
) -> RecommendationSet:
    """One recommendation per finding, each traceable to the page it came from."""
    out = RecommendationSet(site_visit=findings.site_visit,
                            policy=list(policy.describe()))

    for finding in findings.findings:
        work, work_why = work_type_of(finding)
        urgency, urgency_why = urgency_of(finding, policy)
        shutdown, shutdown_why = shutdown_needed(finding, policy)

        evidence: list[dict[str, Any]] = []
        if finding.source is not None:
            evidence.append(finding.source.to_dict())
        if finding.thermal is not None and finding.thermal.source is not None:
            evidence.append(finding.thermal.source.to_dict())

        rationale = [
            f"work type: {work_why}",
            f"urgency: {urgency_why}",
            f"shutdown: {shutdown_why}",
        ]
        if finding.thermal is not None:
            thermal = finding.thermal
            rationale.append(
                "thermal: the IR report measured a difference temperature of "
                f"{thermal.difference_temperature_c}C, which falls in its own "
                f"{thermal.derived_severity or 'unstated'} band"
            )

        warnings = list(finding.warnings)
        if not work:
            warnings.append(
                "the report does not say whether to repair or replace; a person "
                "has to decide before this can be priced"
            )

        out.recommendations.append(
            Recommendation(
                finding_id=finding.finding_id,
                tag_id=finding.tag_id,
                customer_id=finding.customer_id,
                equipment_type=finding.equipment_type,
                location=finding.location,
                work_type=work,
                technician_recommendation=list(finding.narrative),
                problem_description=finding.problem_description,
                severity=finding.severity,
                urgency=urgency,
                requires_shutdown=shutdown,
                consequences=finding.ticked_consequences,
                already_corrected=finding.problem_corrected,
                estimate_required=finding.estimate_required,
                rationale=rationale,
                evidence=evidence,
                warnings=warnings,
                review_required=True,
            )
        )

    out.recommendations.sort(
        key=lambda r: (URGENCY_ORDER.index(r.urgency), r.tag_id, r.finding_id)
    )
    out.warnings = list(findings.warnings)
    return out


def cite(source: SourceRef | dict[str, Any]) -> str:
    if isinstance(source, dict):
        label = source.get("page_label") or source.get("page")
        return f"{source.get('document', '')}, page {label}"
    return source.cite()
