"""A first-pass estimate, with every number's origin on the page.

An estimate is the one output here that can cost somebody real money if it is
wrong and believed. So this module is built around three refusals:

  1. **No rate is compiled in.** Labour rates, crew sizes, shutdown overheads
     and material allowances come from a rate card the operator supplies. The
     card that ships is marked ``placeholder: true`` and every total built from
     it is stamped ``NOT PRICED``. There is no default hourly rate hiding in
     this file for somebody to inherit by accident.
  2. **No single number.** Every line is a range -- low, expected, high -- and
     the range comes from the card's own stated uncertainty for that work type.
     A single figure invites a customer to hold you to it.
  3. **No silent gaps.** A finding whose work type the report did not state, or
     whose equipment class is not on the card, is listed as *not estimated*
     with the reason. It is never quietly dropped, and never priced from the
     nearest-looking row.

What the estimate *is* good for: telling a coworker which items need pricing,
what work each involves in the technician's own words, roughly how big the job
is, and which ones need an outage. That is a morning's work saved. It is not a
quotation and the output says so on every path out of here.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .recommend import Recommendation, RecommendationSet

ESTIMATE_SCHEMA_VERSION = 1

NOT_PRICED = "NOT PRICED"


class RateCardError(Exception):
    """The rate card is missing, malformed, or does not cover the work."""


@dataclass
class RateCard:
    """What an hour and a part cost, and how sure the card is about that.

    ``placeholder`` is the important field. It is true for the card that ships
    with the repository, and while it is true every total carries a banner
    saying the money is not real. Turning it off is a deliberate act by whoever
    owns the numbers.
    """

    source: str = ""
    currency: str = "USD"
    placeholder: bool = True
    labour_rate_per_hour: float | None = None
    shutdown_premium_hours: float = 0.0
    minimum_hours: float = 0.0
    uncertainty: dict[str, float] = field(default_factory=dict)
    work: dict[str, dict[str, Any]] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | str) -> "RateCard":
        import yaml

        path = Path(path)
        if not path.exists():
            raise RateCardError(
                f"no rate card at {path}. Estimates need one; copy "
                "config/estimating.example.yaml and put your own numbers in it."
            )
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise RateCardError(f"{path}: expected a YAML mapping")
        data = dict(raw.get("rate_card") or raw)
        card = cls(
            source=str(path),
            currency=str(data.get("currency", "USD")),
            placeholder=bool(data.get("placeholder", True)),
            labour_rate_per_hour=_optional_float(data.get("labour_rate_per_hour")),
            shutdown_premium_hours=float(data.get("shutdown_premium_hours", 0.0)),
            minimum_hours=float(data.get("minimum_hours", 0.0)),
            uncertainty={k: float(v) for k, v in (data.get("uncertainty") or {}).items()},
            work={str(k): dict(v) for k, v in (data.get("work") or {}).items()},
            notes=list(data.get("notes") or []),
        )
        if not card.work:
            raise RateCardError(f"{path}: the rate card lists no work types")
        return card

    def row_for(self, work_type: str, equipment_type: str) -> tuple[dict[str, Any], str]:
        """The card row covering this work, and how it was chosen.

        Looked up most specific first: the exact equipment class under the work
        type, then that work type's default. A miss returns ``({}, reason)`` --
        it does not fall through to something that merely looks similar.
        """
        block = self.work.get(work_type)
        if not block:
            return {}, f"the rate card has no entry for work type {work_type!r}"
        by_equipment = block.get("by_equipment") or {}
        for name, row in by_equipment.items():
            if name.lower() in (equipment_type or "").lower():
                return dict(row), f"rate card row {work_type}/{name}"
        default = block.get("default")
        if default:
            return dict(default), f"rate card row {work_type}/default"
        return {}, (
            f"the rate card covers {work_type!r} but has no row matching "
            f"{equipment_type!r} and no default"
        )


@dataclass
class Line:
    """One estimated item. Every number is followed by where it came from."""

    finding_id: str = ""
    tag_id: str = ""
    equipment_type: str = ""
    location: str = ""
    work_type: str = ""
    summary: str = ""
    urgency: str = ""
    requires_shutdown: bool | None = None
    labour_hours: dict[str, float] = field(default_factory=dict)
    material_allowance: dict[str, float] = field(default_factory=dict)
    total: dict[str, float] = field(default_factory=dict)
    priced: bool = False
    not_priced_reason: str = ""
    assumptions: list[str] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Estimate:
    schema_version: int = ESTIMATE_SCHEMA_VERSION
    site_visit: str = ""
    currency: str = "USD"
    rate_card: str = ""
    placeholder_rates: bool = True
    lines: list[Line] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    status: str = NOT_PRICED
    disclaimer: str = ""

    @property
    def priced_lines(self) -> list[Line]:
        return [line for line in self.lines if line.priced]

    def totals(self) -> dict[str, float]:
        out = {"low": 0.0, "expected": 0.0, "high": 0.0}
        for line in self.priced_lines:
            for key in out:
                out[key] += float(line.total.get(key, 0.0))
        return {k: round(v, 2) for k, v in out.items()}

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "site_visit": self.site_visit,
            "status": self.status,
            "disclaimer": self.disclaimer,
            "currency": self.currency,
            "rate_card": self.rate_card,
            "placeholder_rates": self.placeholder_rates,
            "totals": self.totals(),
            "assumptions": list(self.assumptions),
            "lines": [line.to_dict() for line in self.lines],
            "warnings": list(self.warnings),
            "counts": {
                "lines": len(self.lines),
                "priced": len(self.priced_lines),
                "not_priced": len(self.lines) - len(self.priced_lines),
            },
        }


DRAFT_DISCLAIMER = (
    "DRAFT ESTIMATE -- NOT A QUOTATION. Produced automatically from the "
    "inspection reports cited on each line. Hours and materials are allowances "
    "from the named rate card, not a measured take-off. No site conditions, "
    "access, permits, lead times or customer-specific terms have been "
    "considered. A qualified estimator must review every line before any figure "
    "is shown to a customer."
)

PLACEHOLDER_BANNER = (
    "The rate card in use is marked 'placeholder'. Its numbers are illustrative "
    "and are NOT this business's rates. Every money figure below is therefore "
    "meaningless until somebody replaces the card and sets 'placeholder: false'."
)


def estimate(
    recommendations: RecommendationSet,
    card: RateCard,
    *,
    include_corrected: bool = False,
) -> Estimate:
    """Price what can be priced, and say plainly what cannot.

    By default an item the technician already fixed on the visit is not
    estimated -- there is nothing left to sell -- but it is still listed, so
    the coworker can see it was considered rather than lost.
    """
    out = Estimate(
        site_visit=recommendations.site_visit,
        currency=card.currency,
        rate_card=card.source,
        placeholder_rates=card.placeholder,
        disclaimer=DRAFT_DISCLAIMER,
        status=NOT_PRICED if card.placeholder else "DRAFT",
    )
    out.assumptions = [
        f"labour is charged at a single blended rate of "
        f"{_money(card.labour_rate_per_hour, card.currency)} per hour",
        f"a minimum of {card.minimum_hours} labour hour(s) is applied to any item",
        f"work needing an outage carries {card.shutdown_premium_hours} extra "
        "hour(s) for isolation, lock-out and re-energising",
        "hours are per item and assume normal working access to the equipment",
        "materials are an allowance, not a priced bill of materials",
        "no permit, scaffold, testing-agency or after-hours cost is included",
    ] + list(card.notes)
    if card.placeholder:
        out.assumptions.insert(0, PLACEHOLDER_BANNER)
        out.warnings.append(PLACEHOLDER_BANNER)

    for recommendation in recommendations.recommendations:
        out.lines.append(_line_for(recommendation, card, include_corrected))

    unpriced = [line for line in out.lines if not line.priced]
    if unpriced:
        out.warnings.append(
            f"{len(unpriced)} of {len(out.lines)} item(s) could not be estimated; "
            "each says why on its own line"
        )
    return out


def _line_for(
    recommendation: Recommendation, card: RateCard, include_corrected: bool
) -> Line:
    line = Line(
        finding_id=recommendation.finding_id,
        tag_id=recommendation.tag_id,
        equipment_type=recommendation.equipment_type,
        location=recommendation.location,
        work_type=recommendation.work_type,
        summary=_summary(recommendation),
        urgency=recommendation.urgency,
        requires_shutdown=recommendation.requires_shutdown,
        evidence=list(recommendation.evidence),
        warnings=list(recommendation.warnings),
    )

    if recommendation.already_corrected and not include_corrected:
        line.not_priced_reason = (
            "the technician recorded this as corrected during the visit, so "
            "there is no outstanding work to price"
        )
        return line
    if not recommendation.work_type:
        line.not_priced_reason = (
            "the report does not say whether to repair or replace, so the scope "
            "is undecided"
        )
        return line
    if card.labour_rate_per_hour is None:
        line.not_priced_reason = "the rate card states no labour rate"
        return line

    row, how = card.row_for(recommendation.work_type, recommendation.equipment_type)
    if not row:
        line.not_priced_reason = how
        return line

    hours = float(row.get("labour_hours", 0.0))
    if hours <= 0:
        line.not_priced_reason = f"{how} states no labour hours"
        return line

    if recommendation.requires_shutdown:
        hours += card.shutdown_premium_hours
    hours = max(hours, card.minimum_hours)

    spread = float(
        row.get("uncertainty",
                card.uncertainty.get(recommendation.work_type,
                                     card.uncertainty.get("default", 0.0)))
    )
    materials = float(row.get("material_allowance", 0.0))
    rate = float(card.labour_rate_per_hour)

    line.labour_hours = {
        "low": round(hours * (1 - spread), 2),
        "expected": round(hours, 2),
        "high": round(hours * (1 + spread), 2),
    }
    line.material_allowance = {
        "low": round(materials * (1 - spread), 2),
        "expected": round(materials, 2),
        "high": round(materials * (1 + spread), 2),
    }
    line.total = {
        key: round(line.labour_hours[key] * rate + line.material_allowance[key], 2)
        for key in ("low", "expected", "high")
    }
    line.priced = True
    line.assumptions = [
        f"hours and materials from {how}",
        f"base labour {row.get('labour_hours')} h"
        + (f" plus {card.shutdown_premium_hours} h shutdown premium"
           if recommendation.requires_shutdown else "")
        + (f", raised to the {card.minimum_hours} h minimum"
           if hours == card.minimum_hours
           and float(row.get("labour_hours", 0)) < card.minimum_hours else ""),
        f"range is +/-{int(spread * 100)}%, the card's stated uncertainty for this work",
        f"material allowance {_money(materials, card.currency)}",
    ]
    if recommendation.requires_shutdown:
        line.assumptions.append(
            "an outage is assumed because the technician's repair text calls for one; "
            "its cost to the customer's operation is NOT included"
        )
    return line


def _summary(recommendation: Recommendation) -> str:
    text = " ".join(recommendation.technician_recommendation).strip()
    return text or recommendation.problem_description


def _money(value: float | None, currency: str) -> str:
    if value is None:
        return f"(no rate set, {currency})"
    return f"{currency} {value:,.2f}"


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)
