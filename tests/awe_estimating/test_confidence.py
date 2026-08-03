"""Confidence, and the requirement that it always says why.

A level with no reasons is decoration: somebody reads "medium" and learns
nothing they can act on. Every test here checks the reasons as well as the
level, and several check only the reasons.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from awe_estimating import (
    Confidence, Estimate, LineItem, LineKind, ScopeItem,
    assess_confidence, apply_confidence, from_config, from_report, proposed_by_ai,
)
from awe_estimating.confidence import ConfidenceRules
from awe_estimating.evidence import Assumption, Clarification


def _line(priceable: bool = True) -> LineItem:
    return LineItem(
        kind=LineKind.LABOUR, quantity="4", unit_cost="100.00",
        rate_provenance=from_config("r") if priceable else proposed_by_ai("m"),
        quantity_provenance=from_config("q"),
    )


def _item(scope_id: str, priceable: bool = True, **kw) -> ScopeItem:
    return ScopeItem(scope_id=scope_id, lines=[_line(priceable)], **kw)


def _estimate(*items: ScopeItem, **kw) -> Estimate:
    kw.setdefault("range_low_factor", "0.9")
    kw.setdefault("range_high_factor", "1.1")
    return Estimate(scope=list(items), **kw)


def test_everything_priced_and_nothing_open_is_high():
    report = assess_confidence(_estimate(_item("a"), _item("b")))
    assert report.level is Confidence.HIGH
    assert report.reasons, "even a clean result explains itself"
    assert report.priced_fraction == Decimal("1")


def test_a_level_never_comes_back_without_reasons():
    for estimate in (
        _estimate(_item("a")),
        _estimate(_item("a", priceable=False)),
        _estimate(),
    ):
        assert assess_confidence(estimate).reasons


def test_the_reasons_say_what_to_go_and_look_at():
    est = _estimate(_item("a"), _item("b", priceable=False))
    reasons = assess_confidence(est).reasons
    assert any("could not be priced" in r and "says why" in r for r in reasons)


def test_a_blocking_question_stops_it_being_high():
    est = _estimate(_item("a"))
    est.scope[0].clarifications.append(
        Clarification(question="how many?", blocks_pricing=True))
    report = assess_confidence(est)
    assert report.level is not Confidence.HIGH
    assert report.blocking_questions == 1
    assert any("must be answered" in r for r in report.reasons)


def test_a_non_blocking_question_is_still_reported():
    est = _estimate(_item("a"))
    est.scope[0].clarifications.append(Clarification(question="after hours?"))
    report = assess_confidence(est)
    assert any("would change the price" in r for r in report.reasons)


def test_an_unconfirmed_assumption_is_named_as_needing_somebody():
    est = _estimate(_item("a"))
    est.assumptions.append(
        Assumption(text="four hours", provenance=proposed_by_ai("some-model")))
    report = assess_confidence(est)
    assert report.unconfirmed_assumptions == 1
    assert any("confirm or replace" in r for r in report.reasons)


def test_a_template_rate_card_prevents_high_however_clean_the_scope():
    """Nothing is high-confidence when the money is not real."""
    est = _estimate(_item("a"))
    est.warnings.append("the rate card in use is a template, so every figure ...")
    report = assess_confidence(est)
    assert report.level is not Confidence.HIGH
    assert any("illustrative" in r for r in report.reasons)


def test_a_wide_range_prevents_high_and_says_how_wide():
    est = _estimate(_item("a"), range_low_factor="0.5", range_high_factor="2.0")
    report = assess_confidence(est)
    assert report.level is not Confidence.HIGH
    assert any("times wider at the top" in r for r in report.reasons)


def test_mostly_unpriceable_scope_is_insufficient():
    est = _estimate(*[_item(str(i), priceable=False) for i in range(4)], _item("ok"))
    report = assess_confidence(est)
    assert report.level is Confidence.INSUFFICIENT


def test_nothing_to_price_is_insufficient_and_says_so():
    report = assess_confidence(_estimate())
    assert report.level is Confidence.INSUFFICIENT
    assert any("no scope was produced" in r for r in report.reasons)


def test_an_all_excluded_estimate_is_insufficient_not_high():
    """Nine items fixed on the visit is not a confident estimate of nothing."""
    est = _estimate(_item("a", excluded_reason="fixed on the visit"))
    report = assess_confidence(est)
    assert report.level is Confidence.INSUFFICIENT
    assert any("nothing to price" in r for r in report.reasons)


def test_excluded_items_are_reported_but_do_not_count_against_the_fraction():
    est = _estimate(_item("a"), _item("b", excluded_reason="already done"))
    report = assess_confidence(est)
    assert report.priced_fraction == Decimal("1")
    assert any("deliberately excluded" in r for r in report.reasons)


def test_ancillary_costs_do_not_flatter_the_score():
    """Mobilization always prices. It must not make a bad estimate look good."""
    est = _estimate(_item("a", priceable=False),
                    ScopeItem(scope_id="mob", lines=[_line()], ancillary=True))
    assert assess_confidence(est).priced_fraction == Decimal("0")


def test_the_thresholds_are_configuration():
    est = _estimate(_item("a"))
    est.scope[0].clarifications.append(Clarification(question="one question"))
    strict = assess_confidence(est, ConfidenceRules())
    lenient = assess_confidence(est, ConfidenceRules(high_max_open_questions=5))
    assert strict.level is not Confidence.HIGH
    assert lenient.level is Confidence.HIGH


def test_the_rules_in_force_travel_with_the_report():
    report = assess_confidence(_estimate(_item("a")))
    assert any("nobody has confirmed these" in r for r in report.rules)


def test_rules_can_be_read_from_configuration():
    rules = ConfidenceRules.from_mapping(
        {"high_max_open_questions": 2}, source="config/service.yaml")
    assert rules.high_max_open_questions == 2
    assert "config/service.yaml" in rules.source


def test_scoring_is_deterministic():
    est = _estimate(_item("a"), _item("b", priceable=False))
    assert assess_confidence(est).to_dict() == assess_confidence(est).to_dict()


def test_applying_records_the_result_on_the_estimate():
    est = _estimate(_item("a", priceable=False))
    report = apply_confidence(est)
    assert est.confidence is report.level
    assert est.confidence_reasons == report.reasons
