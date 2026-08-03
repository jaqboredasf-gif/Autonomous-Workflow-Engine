"""Turning scope into money, deterministically.

Given scope items and an approved rate card, this produces an estimate. It has
no opinions of its own: every figure it emits comes from the card and names the
key it came from, and anything the card does not cover comes back as a question
rather than a number.

## The rule that shapes everything here

*When the card is silent, ask.* There is no default rate, no assumed role, no
typical duration. A scope item whose work the card has no rule for produces a
:class:`~awe_estimating.evidence.Clarification` naming exactly what is missing
and what to add to fix it -- and the estimate is still produced, with that item
unpriced and the reason attached.

That is a deliberate trade. A tool that refuses to produce anything until every
gap is closed gets abandoned; a tool that fills gaps quietly produces numbers
nobody can defend. Producing a partial estimate that is loud about its holes is
the only version that survives contact with a real job.

## Provider-independent

Nothing here knows what industry it is pricing. A scope item is a
``work_type`` and an ``asset_type`` -- both plain strings -- plus a quantity.
The card says what those cost. Two workflows sharing this engine differ only in
their adapters and their cards.

The interface a future workflow implements is :class:`ScopeSource`: produce
scope items, and everything downstream is inherited.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable, Protocol, runtime_checkable

from .evidence import Assumption, Clarification, from_config
from .model import (
    Adjustment,
    Estimate,
    LineItem,
    LineKind,
    ScopeItem,
)
from .ratecard import RateCard, Role, WorkRule

ZERO = Decimal("0")


@runtime_checkable
class ScopeSource(Protocol):
    """What a workflow must provide to use this engine.

    The whole contract. A TEGG inspection, a roof survey and a support ticket
    all implement this the same way: turn whatever you know into scope items,
    and inherit pricing, confidence, approval, proposals and calibration.

    Implementations live in the workflow's own package -- never here.
    """

    def scope_items(self) -> list[ScopeItem]:
        """The work to be priced, with its evidence already attached."""
        ...

    def context(self) -> dict[str, str]:
        """Customer, project, site, and what this estimate is *for*.

        Keys used when present: ``customer``, ``project``, ``site``,
        ``source_reference``. Anything else is carried but not interpreted.
        """
        ...


@dataclass
class PricingResult:
    """The estimate, plus what the engine could not do and why."""

    estimate: Estimate
    clarifications: list[Clarification]
    unmatched: list[tuple[str, str]]

    @property
    def complete(self) -> bool:
        return not self.clarifications and not self.unmatched


def _round_hours(hours: Decimal, step: Decimal) -> Decimal:
    if step <= 0:
        return hours
    return (hours / step).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * step


def _resolve_role(card: RateCard, rule: WorkRule | None) -> Role | None:
    name = (rule.role if rule and rule.role else card.default_role) or ""
    return card.role(name) if name else None


def _labour_lines(
    item: ScopeItem, card: RateCard, rule: WorkRule
) -> tuple[list[LineItem], list[Clarification], list[Assumption]]:
    role = _resolve_role(card, rule)
    if role is None:
        return [], [Clarification(
            question=(
                f"which labour role does {rule.work_type!r} on "
                f"{item.asset_type or 'this asset'} use?"
            ),
            why_it_matters="without a role there is no hourly rate, so it cannot be priced",
            blocks_pricing=True,
            about=item.scope_id,
            provenance=from_config(rule.config_key()),
        )], []

    if rule.hours is None:
        return [], [Clarification(
            question=(
                f"how many hours does {rule.work_type!r} on "
                f"{item.asset_type or 'this asset'} take?"
            ),
            why_it_matters=(
                f"the rate card has a rule at {rule.config_key()} but it states "
                "no hours, so the effort is unknown"
            ),
            blocks_pricing=True,
            about=item.scope_id,
            provenance=from_config(rule.config_key()),
        )], []

    assumptions: list[Assumption] = []
    hours = rule.hours * item.quantity

    if card.shutdown_premium_hours > 0 and _needs_outage(item):
        hours += card.shutdown_premium_hours
        assumptions.append(Assumption(
            text=(
                f"{card.shutdown_premium_hours} extra hour(s) for isolation and "
                "re-energising, because the recommended work needs an outage"
            ),
            provenance=from_config("labour.shutdown_premium_hours"),
        ))

    if card.minimum_hours > 0 and hours < card.minimum_hours:
        assumptions.append(Assumption(
            text=(
                f"raised to the {card.minimum_hours}-hour minimum "
                f"(the work itself is {hours})"
            ),
            provenance=from_config("labour.minimum_hours"),
        ))
        hours = card.minimum_hours

    hours = _round_hours(hours, card.hour_rounding)

    line = LineItem(
        kind=LineKind.LABOUR,
        description=f"{rule.work_type} — {item.asset_type or item.issue}".strip(" —"),
        role=role.name,
        quantity=hours,
        unit="hour",
        unit_cost=role.rate_per_hour,
        rate_provenance=from_config(role.key()),
        quantity_provenance=from_config(
            rule.config_key(), f"{rule.hours} h per {item.unit}"
        ),
    )
    return [line], [], assumptions


def _needs_outage(item: ScopeItem) -> bool:
    """Whether the scope says an outage is needed.

    Read from the item's own constraints rather than by inspecting prose, so
    the judgement stays with the adapter that has the domain knowledge.
    """
    return any("outage" in c.lower() or "shutdown" in c.lower()
               for c in item.access_constraints)


def _material_lines(
    item: ScopeItem, card: RateCard, rule: WorkRule
) -> tuple[list[LineItem], list[Clarification]]:
    lines: list[LineItem] = []
    questions: list[Clarification] = []

    for key, quantity in rule.materials:
        material = card.material(key)
        if material is None:
            questions.append(Clarification(
                question=f"what does material {key!r} cost?",
                why_it_matters=(
                    f"{rule.config_key()} calls for it but materials.items has "
                    "no entry, so it cannot be priced"
                ),
                blocks_pricing=True,
                about=item.scope_id,
                provenance=from_config(f"materials.items.{key}"),
            ))
            continue
        lines.append(LineItem(
            kind=LineKind.MATERIAL,
            description=material.description or key,
            quantity=quantity * item.quantity,
            unit=material.unit,
            unit_cost=material.unit_cost,
            markup_rate=card.material_markup,
            rate_provenance=from_config(material.config_key()),
            quantity_provenance=from_config(rule.config_key()),
        ))

    if rule.material_allowance > 0:
        lines.append(LineItem(
            kind=LineKind.MATERIAL,
            description="material allowance",
            quantity=item.quantity,
            unit=item.unit,
            unit_cost=rule.material_allowance,
            markup_rate=card.material_markup,
            rate_provenance=from_config(rule.config_key(), "material_allowance"),
            quantity_provenance=from_config(rule.config_key()),
            notes="an allowance, not a priced bill of materials",
        ))
    return lines, questions


def price_item(item: ScopeItem, card: RateCard) -> ScopeItem:
    """Attach priced lines to one scope item. Returns the same item, populated.

    An item the card cannot price keeps its evidence and gains a clarification.
    It is never dropped, and never given a number.
    """
    if item.excluded_reason:
        return item

    work_type = _work_type_of(item)
    if not work_type:
        # The adapter has already asked what kind of work this is. Repeating
        # the question in the engine's words would be noise, so it only records
        # that pricing is blocked.
        item.clarifications.append(Clarification(
            question="what kind of work is this?",
            why_it_matters=(
                "no work type was stated, so no rate-card rule can match and "
                "nothing can be priced"
            ),
            blocks_pricing=True,
            about=item.scope_id,
            provenance=from_config("work"),
        ))
        return item

    rule = card.rule_for(work_type, item.asset_type)
    if rule is None:
        item.clarifications.append(Clarification(
            question=(
                f"what does {work_type!r} on "
                f"{item.asset_type or 'this asset type'} involve?"
            ),
            why_it_matters=(
                "the rate card has no rule matching it, so there is no effort, "
                "role or material to price. Add one under 'work:'."
            ),
            blocks_pricing=True,
            about=item.scope_id,
            provenance=from_config("work"),
        ))
        return item

    labour, labour_questions, assumptions = _labour_lines(item, card, rule)
    materials, material_questions = _material_lines(item, card, rule)

    item.lines.extend(labour + materials)
    item.clarifications.extend(labour_questions + material_questions)
    item.assumptions.extend(assumptions)
    if rule.notes:
        item.assumptions.append(Assumption(
            text=rule.notes, provenance=from_config(rule.config_key()), material=False
        ))
    return item


def _work_type_of(item: ScopeItem) -> str:
    """The work type an item asks for -- the token, never the prose.

    This used to fall back to ``recommended_work`` when ``work_type`` was
    empty. That looks harmless and is not: ``recommended_work`` is a sentence a
    technician wrote, so the fallback turned "Relocate other equipment and/or
    intrusions to dedicated space in order to facilitate safe cover removal"
    into a vocabulary token, reported it as an unmatched work type, and asked
    the reader what that sentence "involves". An item with no work type has no
    work type; the adapter is responsible for saying so.
    """
    return item.work_type


def price(
    source: ScopeSource | Iterable[ScopeItem],
    card: RateCard,
    *,
    prepared_by: str = "",
    prepared_at: str = "",
    estimate_id: str = "",
) -> PricingResult:
    """Build an estimate from scope and an approved card.

    Deterministic: the same scope and the same card produce the same estimate,
    to the cent, every time. Nothing here samples, guesses or defaults.
    """
    if isinstance(source, ScopeSource) and hasattr(source, "scope_items"):
        items = list(source.scope_items())
        context = dict(source.context() or {})
    else:
        items = list(source)                                # type: ignore[arg-type]
        context = {}

    priced = [price_item(item, card) for item in items]

    adjustments = [
        Adjustment(
            kind=kind,
            rate=card.adjustments[kind],
            provenance=from_config(f"adjustments.{kind.value}"),
        )
        for kind in card.adjustment_order
        if kind in card.adjustments
    ]

    estimate = Estimate(
        estimate_id=estimate_id,
        currency=card.currency,
        customer=context.get("customer", ""),
        project=context.get("project", ""),
        site=context.get("site", ""),
        source_reference=context.get("source_reference", ""),
        prepared_by=prepared_by,
        prepared_at=prepared_at,
        scope=priced,
        adjustments=adjustments,
        range_low_factor=card.range_low_factor,
        range_high_factor=card.range_high_factor,
        pricing_source=card.describe(),
    )

    if card.mobilization_per_visit > 0:
        estimate.scope.append(_mobilization(card))

    if card.placeholder:
        estimate.warnings.append(
            "the rate card in use is a template, so every figure here is "
            "illustrative and none of it is this business's prices"
        )

    clarifications = estimate.open_questions
    unmatched = card.unmatched_vocabulary(
        (_work_type_of(i), i.asset_type)
        for i in items
        if not i.excluded_reason and _work_type_of(i)
    )
    if unmatched:
        estimate.warnings.append(
            f"{len(unmatched)} kind(s) of work have no rule in "
            f"{card.name or 'the rate card'}: "
            + ", ".join(f"{w or '?'} on {a or 'any asset'}" for w, a in unmatched[:5])
        )

    return PricingResult(estimate, clarifications, unmatched)


def _mobilization(card: RateCard) -> ScopeItem:
    """Getting to site, priced once per visit rather than per item."""
    item = ScopeItem(
        scope_id="mobilization",
        issue="attending site",
        recommended_work="mobilization",
        quantity=Decimal("1"),
        unit="visit",
        ancillary=True,
    )
    item.lines.append(LineItem(
        kind=LineKind.TRAVEL,
        description="mobilization",
        quantity=Decimal("1"),
        unit="visit",
        unit_cost=card.mobilization_per_visit,
        rate_provenance=from_config("mobilization.per_visit"),
        quantity_provenance=from_config(
            "mobilization.per_visit", "one visit assumed"
        ),
    ))
    return item
