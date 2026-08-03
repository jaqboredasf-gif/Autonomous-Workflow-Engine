"""The rules that stop an estimate being confidently wrong.

Most of this file is about refusals. An estimating engine that computes
correctly from bad inputs is more dangerous than one that does not compute at
all, because the output looks the same either way.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from awe_estimating import (
    Adjustment, AdjustmentKind, Alternate, Confidence, Estimate, Exclusion,
    LineItem, LineKind, ScopeItem, from_config, from_human, from_report,
    proposed_by_ai, money, to_cents,
)
from awe_estimating.evidence import Assumption, Clarification, EvidenceClass


def _labour(**kw) -> LineItem:
    base = dict(
        kind=LineKind.LABOUR, description="work", quantity="4", unit="hour",
        unit_cost="100.00",
        rate_provenance=from_config("rate_card.labour.default"),
        quantity_provenance=from_human("estimator"),
    )
    base.update(kw)
    return LineItem(**base)


# -- money ----------------------------------------------------------------


def test_a_float_can_never_become_money():
    """Decimal(0.1) is 0.1000000000000000055..., and that reaches an estimate
    the moment somebody passes a rate straight out of json.load."""
    with pytest.raises(TypeError) as caught:
        money(0.1)
    assert "float" in str(caught.value) and "string" in str(caught.value)


def test_money_from_strings_is_exact():
    assert money("0.1") + money("0.2") == money("0.3")


def test_money_accepts_nothing_as_zero():
    assert money(None) == Decimal("0") and money("") == Decimal("0")


# -- a model's suggestion is not evidence ---------------------------------


def test_an_ai_proposal_cannot_price_anything():
    line = _labour(rate_provenance=proposed_by_ai("some-model"))
    assert not line.priceable
    assert line.total == Decimal("0"), "an unpriceable line contributes zero, not a guess"
    assert "proposed by a model" in line.blockers[0]


def test_an_ai_proposal_can_price_once_something_confirms_it():
    proposal = proposed_by_ai("some-model", "4 hours for this equipment class")
    assert not proposal.may_price

    confirmed = proposal.confirm("J. Daly", locator="rate_card.labour.switchgear")
    assert confirmed.may_price
    assert "confirmed by J. Daly" in confirmed.cite()

    assert _labour(quantity_provenance=confirmed).priceable


def test_evidence_with_no_locator_cannot_price():
    """'A report says so' is not checkable without saying which page."""
    from awe_estimating import Provenance

    vague = Provenance(EvidenceClass.REPORT, locator="")
    assert not vague.may_price
    assert "cannot be checked" in vague.why_not()


@pytest.mark.parametrize("maker,locator", [
    (from_config, "rate_card.labour"), (from_report, "IR p.2A"),
    (from_human, "J. Daly"),
])
def test_real_evidence_with_a_locator_prices(maker, locator):
    assert maker(locator).may_price


def test_only_ai_proposals_are_not_evidence():
    for kind in EvidenceClass:
        assert kind.is_evidence is (kind is not EvidenceClass.AI_PROPOSAL)


# -- scope items ----------------------------------------------------------


def test_an_item_with_one_unpriceable_line_is_wholly_unpriced():
    """Half-pricing an item produces a number that looks complete and is not."""
    item = ScopeItem(scope_id="a", lines=[
        _labour(), _labour(rate_provenance=proposed_by_ai("m")),
    ])
    assert not item.priceable
    assert item.subtotal() == Decimal("0")


def test_an_item_with_no_lines_says_so_rather_than_costing_nothing():
    item = ScopeItem(scope_id="a", issue="something")
    assert not item.priceable
    assert "nothing has been costed" in item.blocked_by[0]


def test_a_deliberately_excluded_item_is_not_priced_and_says_why():
    item = ScopeItem(scope_id="a", lines=[_labour()],
                     excluded_reason="the technician fixed it on the visit")
    assert not item.priceable
    assert item.blocked_by == ["the technician fixed it on the visit"]


def test_a_blocking_clarification_stops_the_item_being_priced():
    item = ScopeItem(scope_id="a", lines=[_labour()], clarifications=[
        Clarification(question="how many buckets?", blocks_pricing=True),
    ])
    assert "how many buckets?" in item.blocked_by


def test_a_material_markup_applies_to_that_line_only():
    line = LineItem(kind=LineKind.MATERIAL, quantity="2", unit_cost="100.00",
                    markup_rate="0.25",
                    rate_provenance=from_config("m"), quantity_provenance=from_report("p1"))
    assert line.base == Decimal("200.00")
    assert line.total == Decimal("250.00")


# -- adjustments ----------------------------------------------------------


def _estimate(**kw) -> Estimate:
    base = dict(scope=[ScopeItem(scope_id="a", lines=[_labour()])])
    base.update(kw)
    return Estimate(**base)


def test_adjustments_compound_in_the_declared_order():
    """Overhead, then contingency, then profit, then tax. Stated, not emergent."""
    est = _estimate(adjustments=[
        Adjustment(AdjustmentKind.TAX, "0.10", from_config("tax")),
        Adjustment(AdjustmentKind.OVERHEAD, "0.10", from_config("oh")),
        Adjustment(AdjustmentKind.PROFIT, "0.10", from_config("profit")),
    ])
    applied = est.applied_adjustments()
    assert [a.kind for a, _, _ in applied] == [
        AdjustmentKind.OVERHEAD, AdjustmentKind.PROFIT, AdjustmentKind.TAX,
    ]
    # 400 -> +40 = 440 -> +44 = 484 -> +48.40 = 532.40
    assert to_cents(est.total) == Decimal("532.40")


def test_an_adjustment_can_apply_to_one_kind_of_line_only():
    est = Estimate(scope=[ScopeItem(scope_id="a", lines=[
        _labour(),
        LineItem(kind=LineKind.MATERIAL, quantity="1", unit_cost="1000.00",
                 rate_provenance=from_config("m"), quantity_provenance=from_report("p")),
    ])], adjustments=[
        Adjustment(AdjustmentKind.OVERHEAD, "0.50", from_config("oh"),
                   applies_to=(LineKind.LABOUR,)),
    ])
    _, base, amount = est.applied_adjustments()[0]
    assert base == Decimal("400.00"), "only the labour"
    assert amount == Decimal("200.00")
    assert to_cents(est.total) == Decimal("1600.00")


def test_an_unpriceable_item_is_excluded_from_every_adjustment_base():
    est = Estimate(scope=[
        ScopeItem(scope_id="a", lines=[_labour()]),
        ScopeItem(scope_id="b", lines=[_labour(rate_provenance=proposed_by_ai("m"))]),
    ], adjustments=[Adjustment(AdjustmentKind.PROFIT, "0.10", from_config("p"))])
    assert est.subtotal == Decimal("400.00")
    assert to_cents(est.total) == Decimal("440.00")


# -- totals ---------------------------------------------------------------


def test_the_total_is_computed_and_cannot_be_set():
    """A stored total is one that can disagree with its own lines."""
    est = _estimate()
    assert not hasattr(Estimate, "total") or isinstance(
        getattr(type(est), "total"), property
    )
    with pytest.raises(AttributeError):
        est.total = Decimal("1")


def test_the_range_multiplies_the_total():
    est = _estimate(range_low_factor="0.80", range_high_factor="1.50")
    low, base, high = est.range
    assert (to_cents(low), to_cents(base), to_cents(high)) == (
        Decimal("320.00"), Decimal("400.00"), Decimal("600.00")
    )


def test_an_estimate_with_nothing_priceable_totals_zero_not_an_error():
    est = Estimate(scope=[ScopeItem(scope_id="a")])
    assert est.total == Decimal("0")
    assert est.unpriced_scope and not est.priced_scope


# -- what has to reach the reader ----------------------------------------


def test_open_questions_gather_from_the_estimate_and_every_item():
    est = _estimate(clarifications=[Clarification(question="top level")])
    est.scope[0].clarifications.append(Clarification(question="item level"))
    assert {c.question for c in est.open_questions} == {"top level", "item level"}


def test_unconfirmed_assumptions_are_surfaced_separately():
    est = _estimate(assumptions=[
        Assumption(text="normal access", provenance=from_human("J. Daly")),
        Assumption(text="four hours", provenance=proposed_by_ai("some-model")),
    ])
    assert [a.text for a in est.unconfirmed_assumptions] == ["four hours"]


def test_the_serialised_form_carries_the_reasons_not_only_the_numbers():
    est = _estimate(scope=[
        ScopeItem(scope_id="a", lines=[_labour()]),
        ScopeItem(scope_id="b", lines=[_labour(rate_provenance=proposed_by_ai("m"))]),
    ], confidence=Confidence.LOW, confidence_reasons=["one item could not be priced"],
        exclusions=[Exclusion(text="permits", provenance=from_config("terms"))])
    data = est.to_dict()
    assert data["counts"] == {"scope_items": 2, "priced": 1, "unpriced": 1,
                              "open_questions": 0, "unconfirmed_assumptions": 0}
    assert data["confidence"] == "low"
    assert data["scope"][1]["blocked_by"], "the reader must see why"
    assert data["exclusions"][0]["text"] == "permits"
    assert data["schema_version"] >= 1


def test_an_alternate_is_priced_separately_from_the_base():
    est = _estimate(alternates=[Alternate(
        alternate_id="alt-1", description="replace instead of repair",
        scope=[ScopeItem(scope_id="z", lines=[_labour(quantity="10")])],
        instead_of="a",
    )])
    assert to_cents(est.total) == Decimal("400.00"), "alternates are not in the base"
    assert to_cents(est.alternates[0].subtotal()) == Decimal("1000.00")
