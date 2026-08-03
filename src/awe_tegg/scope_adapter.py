"""TEGG findings, expressed as estimating scope.

This is the whole of TEGG's coupling to :mod:`awe_estimating`. Everything
above it is inspection-specific -- SSRS exports, infrared sheets, checkbox
geometry -- and everything below it is shared with any other workflow that has
to put a number on work.

The adapter's job is translation, and its discipline is **refusing to invent
the difference**. A TEGG inspection report says what is wrong and what the
technician recommends. It does not say:

  * how many of a thing there are;
  * how long the work takes;
  * which trade does it;
  * what materials are needed, beyond part numbers mentioned in prose.

An estimate needs all four. Three of them come from the rate card, keyed on a
vocabulary this adapter emits. The fourth -- quantity -- is genuinely absent
from the source, and is the one place where a wrong assumption silently
multiplies the price. So it is stated as an assumption on every item, and the
prose is scanned for the signs that it is wrong.

## The vocabulary contract

The adapter emits ``work_type`` of ``repair``, ``replace`` or
``repair and replace``, taken from the checkbox the technician ticked, and
``asset_type`` verbatim from the report's Equipment Type field. The rate card
matches on those. Neither side imports the other, and
``RateCard.unmatched_vocabulary`` reports a disagreement rather than letting it
become a silently unpriced estimate.

Changing the words here means changing them in the card. That is the cost of
keeping the engine industry-agnostic, and it is a cost worth paying once.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from awe_estimating import (
    Assumption,
    Clarification,
    Provenance,
    ScopeItem,
    from_config,
    from_report,
    from_technician,
)

from .recommend import Recommendation, RecommendationSet

#: Wording in a technician's recommendation that means "more than one of
#: these". Quantity is the one number the report never states and the one that
#: multiplies straight through to the price, so its absence is never silent.
PLURAL_HINTS = re.compile(
    r"\b(all|each|every|both|several|multiple|various|throughout|"
    r"\d+\s*(?:of|x|off)\b)",
    re.IGNORECASE,
)

#: Wording that means the equipment must be dead before the work can start.
#: Passed to the engine as an access constraint rather than interpreted there,
#: because knowing what "de-energise" implies is domain knowledge and belongs
#: on this side of the boundary.
OUTAGE_CONSTRAINT = "requires a shutdown or outage"


@dataclass
class TeggScopeSource:
    """A completed site visit's recommendations, as estimating scope.

    Implements :class:`awe_estimating.ScopeSource`. Nothing downstream of this
    class knows it came from an inspection.
    """

    recommendations: RecommendationSet
    customer: str = ""
    site: str = ""
    site_visit: str = ""
    project: str = ""
    #: Items the technician already fixed are carried but not priced. Keeping
    #: them visible is the point: a coworker should see what was considered.
    include_corrected: bool = False
    warnings: list[str] = field(default_factory=list)

    # -- the ScopeSource interface ---------------------------------------
    def context(self) -> dict[str, str]:
        return {
            "customer": self.customer,
            "site": self.site,
            "project": self.project or self.site,
            "source_reference": self.site_visit,
        }

    def scope_items(self) -> list[ScopeItem]:
        return [self._to_scope(r) for r in self.recommendations.recommendations]

    # -- translation ------------------------------------------------------
    def _to_scope(self, recommendation: Recommendation) -> ScopeItem:
        item = ScopeItem(
            scope_id=recommendation.finding_id,
            issue=recommendation.problem_description,
            recommended_work=" ".join(recommendation.technician_recommendation),
            work_type=recommendation.work_type,
            asset_id=recommendation.tag_id,
            asset_type=recommendation.equipment_type,
            location=recommendation.location,
            urgency=recommendation.urgency,
            quantity=Decimal("1"),
            unit="each",
            evidence=[_provenance(e) for e in recommendation.evidence],
        )

        if recommendation.already_corrected and not self.include_corrected:
            item.excluded_reason = (
                "the technician recorded this as corrected during the visit, so "
                "there is no outstanding work to price"
            )
            return item

        if recommendation.requires_shutdown:
            item.access_constraints.append(OUTAGE_CONSTRAINT)
        elif recommendation.requires_shutdown is None:
            item.clarifications.append(Clarification(
                question="does this work need the equipment de-energised?",
                why_it_matters=(
                    "an outage adds isolation and re-energising time, and has to "
                    "be scheduled with the customer"
                ),
                about=item.scope_id,
                provenance=from_report(_first_locator(recommendation)),
            ))

        item.assumptions.append(self._quantity_assumption(recommendation))
        item.clarifications.extend(self._quantity_questions(recommendation, item))

        if not recommendation.work_type:
            item.clarifications.append(Clarification(
                question="is this a repair or a replacement?",
                why_it_matters=(
                    "the report ticks neither 'Repair Equipment' nor 'Replace "
                    "Equipment', and the two cost very different amounts"
                ),
                blocks_pricing=True,
                about=item.scope_id,
                provenance=from_report(_first_locator(recommendation)),
            ))

        if not recommendation.technician_recommendation:
            item.clarifications.append(Clarification(
                question="what work does this item actually need?",
                why_it_matters=(
                    "the report records a problem but no recommendation, so "
                    "there is nothing to price against"
                ),
                blocks_pricing=True,
                about=item.scope_id,
                provenance=from_report(_first_locator(recommendation)),
            ))

        for warning in recommendation.warnings:
            item.clarifications.append(Clarification(
                question=f"check this item by hand: {warning}",
                why_it_matters="the report could not be read cleanly here",
                about=item.scope_id,
                provenance=from_report(_first_locator(recommendation)),
            ))

        return item

    # -- quantity, the number the report never states ---------------------
    def _quantity_assumption(self, recommendation: Recommendation) -> Assumption:
        return Assumption(
            text=(
                "one unit of work on this tag. The inspection report records a "
                "problem per tag, not a count, so quantity is assumed"
            ),
            provenance=from_config("adapter.quantity_default"),
            material=True,
        )

    def _quantity_questions(
        self, recommendation: Recommendation, item: ScopeItem
    ) -> list[Clarification]:
        """Ask when the technician's own words suggest the assumption is wrong.

        "All fuses are incorrectly matched" is one finding and an unknown number
        of fuses. Pricing it as one is the single easiest way for this tool to
        be badly wrong about money, so the prose is checked and the question is
        asked rather than the number being guessed at.
        """
        text = " ".join(
            [recommendation.problem_description, *recommendation.technician_recommendation]
        )
        match = PLURAL_HINTS.search(text)
        if not match:
            return []
        return [Clarification(
            question=(
                f"how many units does this cover? The report says "
                f"{match.group(0)!r}, which suggests more than one"
            ),
            why_it_matters=(
                "quantity multiplies straight through to the price, and the "
                "report states a problem per tag rather than a count"
            ),
            blocks_pricing=False,
            about=item.scope_id,
            provenance=from_technician(_first_locator(recommendation), match.group(0)),
        )]


def _provenance(evidence: dict[str, Any]) -> Provenance:
    document = str(evidence.get("document", "report"))
    page = evidence.get("page_label") or evidence.get("page") or "?"
    return from_report(f"{document}, page {page}",
                       str(evidence.get("quote", ""))[:200])


def _first_locator(recommendation: Recommendation) -> str:
    if not recommendation.evidence:
        return "the inspection report"
    first = recommendation.evidence[0]
    page = first.get("page_label") or first.get("page") or "?"
    return f"{first.get('document', 'report')}, page {page}"


def from_recommendations(
    recommendations: RecommendationSet,
    *,
    customer: str = "",
    site: str = "",
    site_visit: str = "",
    include_corrected: bool = False,
) -> TeggScopeSource:
    """The one call the operation makes to cross into estimating."""
    return TeggScopeSource(
        recommendations=recommendations,
        customer=customer,
        site=site,
        site_visit=site_visit or recommendations.site_visit,
        include_corrected=include_corrected,
    )
