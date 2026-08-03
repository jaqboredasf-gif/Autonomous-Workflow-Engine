"""The pricing engine: deterministic, config-driven, and loud about gaps.

The behaviour under test is mostly *what it refuses to do*. An engine that
produces a plausible number for work it has no rule for is worse than one that
produces nothing, because the output is indistinguishable from a real answer.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from awe_estimating import ScopeItem, price, to_cents
from awe_estimating.ratecard import (
    RateCard, RateCardError, require_production, validate, validate_for_production,
)

EXAMPLE = "config/ratecard.example.yaml"


@pytest.fixture
def card() -> RateCard:
    return RateCard.load(EXAMPLE)


@pytest.fixture
def production(card) -> RateCard:
    """The example card, made production-shaped for tests that need it."""
    card.placeholder = False
    card.name, card.version = "Test Card", "1.0"
    return card


def _item(**kw) -> ScopeItem:
    base = dict(scope_id="s1", work_type="repair", asset_type="Switchgear - Vertical Section")
    base.update(kw)
    return ScopeItem(**base)


# -- loading and validating ----------------------------------------------


def test_the_example_card_loads_and_is_structurally_valid(card):
    assert card.placeholder is True
    assert validate(card) == []
    assert card.role("electrician").rate_per_hour == Decimal("125.00")


def test_yaml_floats_become_exact_decimals(card):
    """0.08875 out of YAML is a float. It must not stay one."""
    from awe_estimating.model import AdjustmentKind

    tax = card.adjustments[AdjustmentKind.TAX]
    assert isinstance(tax, Decimal)
    assert tax == Decimal("0.08875")


def test_a_template_card_is_refused_for_production(card):
    problems = validate_for_production(card)
    assert any("placeholder" in p for p in problems)
    with pytest.raises(RateCardError) as caught:
        require_production(card)
    assert "cannot be used to price real work" in str(caught.value)


def test_a_production_card_must_say_who_and_which_version(card):
    card.placeholder = False
    card.name = card.version = ""
    assert any("name and a version" in p for p in validate_for_production(card))


def test_a_production_card_must_state_overhead_and_profit(production):
    from awe_estimating.model import AdjustmentKind

    del production.adjustments[AdjustmentKind.PROFIT]
    problems = validate_for_production(production)
    assert any("adjustments.profit is not set" in p for p in problems)
    assert any("Zero is a valid answer" in p or "the decision is recorded" in p
               for p in problems)


def test_a_production_card_must_set_an_approval_threshold(production):
    production.approval_threshold = None
    assert any("approval.threshold_total" in p
               for p in validate_for_production(production))


def test_a_production_card_that_still_reads_like_a_template_is_refused(production):
    production.name = "EXAMPLE — replace with your own"
    assert any("not filled in" in p for p in validate_for_production(production))


@pytest.mark.parametrize("mutate,expected", [
    (lambda c: c.roles.clear(), "no work can be priced"),
    (lambda c: setattr(c, "default_role", "welder"), "not in labour.roles"),
])
def test_structural_faults_are_named(card, mutate, expected):
    mutate(card)
    assert any(expected in p for p in validate(card))


def test_a_percentage_written_as_a_percentage_is_caught(card):
    from awe_estimating.model import AdjustmentKind

    card.adjustments[AdjustmentKind.TAX] = Decimal("8.875")
    assert any("Rates are fractions" in p for p in validate(card))


def test_a_missing_card_says_what_to_do(tmp_path):
    with pytest.raises(RateCardError) as caught:
        RateCard.load(tmp_path / "nope.yaml")
    assert "copy the example card" in str(caught.value)


# -- pricing --------------------------------------------------------------


def test_work_the_card_covers_is_priced_from_the_card(production):
    result = price([_item()], production)
    item = result.estimate.scope[0]
    assert item.priceable
    labour = [l for l in item.lines if l.role][0]
    assert labour.unit_cost == Decimal("125.00")
    assert labour.quantity == Decimal("6")          # the Switchgear repair rule
    assert "labour.roles.electrician" in labour.rate_provenance.locator


def test_the_most_specific_rule_wins(production):
    specific = price([_item(asset_type="Branch Circuit Panel")], production)
    generic = price([_item(asset_type="Transformer")], production)
    assert specific.estimate.scope[0].lines[0].quantity == Decimal("3")
    assert generic.estimate.scope[0].lines[0].quantity == Decimal("4")


def test_work_the_card_does_not_cover_asks_rather_than_guesses(production):
    result = price([_item(work_type="rewind", asset_type="Motor")], production)
    item = result.estimate.scope[0]
    assert not item.priceable
    assert item.subtotal() == Decimal("0")
    question = item.clarifications[0]
    assert question.blocks_pricing
    assert "no rule matching it" in question.why_it_matters
    assert "Add one under 'work:'" in question.why_it_matters


def test_an_unpriceable_item_does_not_stop_the_others_being_priced(production):
    result = price([_item(), _item(scope_id="s2", work_type="rewind")], production)
    counts = result.estimate.to_dict()["counts"]
    assert (counts["priced"], counts["unpriced"]) == (1, 1)
    assert result.estimate.total > 0
    assert not result.complete


def test_job_level_costs_are_not_counted_as_findings(production):
    """A reader asking "how many problems" must not be told the van is one."""
    result = price([_item()], production)
    counts = result.estimate.to_dict()["counts"]
    assert counts["scope_items"] == 1, "mobilization is not a finding"
    assert counts["ancillary_items"] == 1
    assert result.estimate.total > Decimal("250.00"), "but it is still charged"


def test_a_material_the_card_cannot_price_is_a_question(production):
    production.materials.clear()
    result = price([_item(work_type="replace", asset_type="Switchgear")], production)
    questions = [c.question for c in result.estimate.open_questions]
    assert any("fuse-class-rk1" in q for q in questions)


def test_the_minimum_hours_floor_is_applied_and_stated(production):
    production.work_rules = tuple(
        r for r in production.work_rules if r.asset_type != "Branch Circuit Panel"
    )
    production.minimum_hours = Decimal("8")
    result = price([_item()], production)
    item = result.estimate.scope[0]
    assert item.lines[0].quantity == Decimal("8")
    assert any("minimum" in a.text for a in item.assumptions)


def test_an_outage_adds_the_cards_premium_and_says_so(production):
    plain = price([_item()], production).estimate
    outage = price([_item(access_constraints=["requires a shutdown"])],
                   production).estimate
    added = (outage.scope[0].lines[0].quantity - plain.scope[0].lines[0].quantity)
    assert added == production.shutdown_premium_hours
    assert any("outage" in a.text for a in outage.scope[0].assumptions)


def test_mobilization_is_charged_once_not_per_item(production):
    result = price([_item(), _item(scope_id="s2")], production)
    mobilization = [s for s in result.estimate.scope if s.scope_id == "mobilization"]
    assert len(mobilization) == 1
    assert mobilization[0].subtotal() == Decimal("250.00")


def test_an_excluded_item_is_never_priced(production):
    result = price([_item(excluded_reason="fixed on the visit")], production)
    item = result.estimate.scope[0]
    assert not item.priceable and item.lines == []


def test_pricing_is_deterministic(production):
    first = price([_item(), _item(scope_id="s2")], production).estimate.total
    second = price([_item(), _item(scope_id="s2")], production).estimate.total
    assert first == second


def test_a_template_card_marks_the_whole_estimate_as_not_real(card):
    result = price([_item()], card)
    assert any("template" in w for w in result.estimate.warnings)


def test_the_estimate_names_which_card_priced_it(production):
    estimate = price([_item()], production).estimate
    assert "Test Card" in estimate.pricing_source
    assert "production" in estimate.pricing_source


def test_vocabulary_the_card_does_not_share_is_reported_up_front(production):
    result = price([_item(work_type="rewind", asset_type="Motor")], production)
    assert result.unmatched == [("rewind", "Motor")]
    assert any("have no rule" in w for w in result.estimate.warnings)


def test_every_number_names_the_config_key_it_came_from(production):
    estimate = price([_item()], production).estimate
    for line in estimate.scope[0].lines:
        assert line.rate_provenance.kind.value == "configuration"
        assert line.rate_provenance.locator, "a rate with no key cannot be checked"
    for adjustment in estimate.adjustments:
        assert adjustment.provenance.locator.startswith("adjustments.")


def test_adjustments_come_from_the_card_in_its_declared_order(production):
    estimate = price([_item()], production).estimate
    assert [a.kind.value for a in estimate.adjustments] == [
        "overhead", "contingency", "profit", "tax"
    ]


def test_the_range_comes_from_the_card(production):
    estimate = price([_item()], production).estimate
    low, base, high = estimate.range
    assert to_cents(low) == to_cents(base * Decimal("0.85"))
    assert to_cents(high) == to_cents(base * Decimal("1.30"))


def test_mobilization_is_not_charged_when_there_is_nothing_to_do(production):
    """Turning up is only a cost if there is something to turn up for.

    An estimate whose every item was already fixed on the visit must total
    zero. Billing the call-out against it produces a plausible-looking number
    for a job that does not exist.
    """
    result = price([_item(excluded_reason="fixed on the visit")], production)
    assert result.estimate.total == Decimal("0")
    assert not any(i.ancillary for i in result.estimate.scope)


def test_mobilization_is_charged_once_there_is_real_work(production):
    result = price([_item(excluded_reason="fixed"), _item(scope_id="s2")], production)
    assert any(i.ancillary for i in result.estimate.scope)
