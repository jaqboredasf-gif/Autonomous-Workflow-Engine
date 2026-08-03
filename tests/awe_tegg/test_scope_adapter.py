"""TEGG findings becoming estimating scope, and what the adapter refuses.

The adapter is the only coupling between an inspection and the estimating
engine, so its discipline is the whole of the boundary: translate what the
report says, and never invent the difference between what a report contains and
what an estimate needs.
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

pytest.importorskip("pypdf")
pytest.importorskip("reportlab")

from awe_estimating import ScopeSource, price                  # noqa: E402
from awe_estimating.ratecard import RateCard                   # noqa: E402
from awe_tegg import findings as F                             # noqa: E402
from awe_tegg import recommend as R                            # noqa: E402
from awe_tegg.scope_adapter import (                           # noqa: E402
    OUTAGE_CONSTRAINT, from_recommendations,
)

from mock_reports import Problem, write_equipment_item_problems  # noqa: E402


def _scope(tmp_path, *problems, include_corrected=False):
    path = write_equipment_item_problems(tmp_path / "eip.pdf", list(problems))
    findings = F.build(equipment_item_problems=path, site_visit="T-1")
    source = from_recommendations(
        R.recommend(findings), customer="Acme", site="Plant 3",
        site_visit="T-1", include_corrected=include_corrected,
    )
    return source, source.scope_items()


def _card() -> RateCard:
    card = RateCard.load("config/ratecard.example.yaml")
    card.placeholder = False
    card.name, card.version = "Test", "1.0"
    return card


# -- the interface --------------------------------------------------------


def test_the_adapter_satisfies_the_platform_interface(tmp_path):
    source, _ = _scope(tmp_path, Problem())
    assert isinstance(source, ScopeSource)
    context = source.context()
    assert context["customer"] == "Acme" and context["source_reference"] == "T-1"


def test_nothing_downstream_needs_to_know_this_was_an_inspection(tmp_path):
    source, _ = _scope(tmp_path, Problem())
    result = price(source, _card())
    assert result.estimate.customer == "Acme"
    assert result.estimate.total >= 0


# -- vocabulary -----------------------------------------------------------


@pytest.mark.parametrize("ticked,expected", [
    (("Repair Equipment",), "repair"),
    (("Replace Equipment",), "replace"),
    (("Repair Equipment", "Replace Equipment"), "repair and replace"),
    ((), ""),
])
def test_the_work_type_comes_from_the_ticked_box(tmp_path, ticked, expected):
    _, items = _scope(tmp_path, Problem(repair=ticked))
    assert items[0].work_type == expected


def test_the_asset_type_is_passed_through_verbatim(tmp_path):
    _, items = _scope(tmp_path, Problem(equipment_type="Switchgear - Vertical Section"))
    assert items[0].asset_type == "Switchgear - Vertical Section"


def test_the_vocabulary_the_adapter_emits_matches_the_example_card(tmp_path):
    """If these two ever disagree, every estimate silently comes back unpriced."""
    _, items = _scope(
        tmp_path,
        Problem(repair=("Repair Equipment",), equipment_type="Switchgear - Vertical Section"),
        Problem(repair=("Replace Equipment",), equipment_type="Branch Circuit Panel <= 400 amp"),
    )
    card = _card()
    assert card.unmatched_vocabulary(
        (i.work_type, i.asset_type) for i in items
    ) == []


# -- what the report does not say ----------------------------------------


def test_quantity_is_assumed_and_always_says_so(tmp_path):
    """The report records a problem per tag, never a count."""
    _, items = _scope(tmp_path, Problem())
    assert items[0].quantity == Decimal("1")
    assumption = items[0].assumptions[0]
    assert "assumed" in assumption.text and assumption.material


@pytest.mark.parametrize("prose", [
    "All fuses are incorrectly matched and should be replaced",
    "Each bucket needs the contacts cleaning",
    "Multiple conductors are installed under one lug",
    "3 of the terminations are damaged",
])
def test_wording_that_implies_more_than_one_is_questioned(tmp_path, prose):
    """Quantity multiplies straight through to price. It is never guessed at."""
    _, items = _scope(tmp_path, Problem(description=prose, repair=("Repair Equipment",)))
    questions = [c.question for c in items[0].clarifications]
    assert any("how many units" in q for q in questions), prose


def test_a_singular_finding_is_not_questioned(tmp_path):
    _, items = _scope(tmp_path, Problem(
        description="The cover screw is missing from this section",
        repair_text="Fit a replacement screw", repair=("Repair Equipment",)))
    assert not any("how many units" in c.question for c in items[0].clarifications)


def test_neither_box_ticked_blocks_pricing_with_a_question(tmp_path):
    _, items = _scope(tmp_path, Problem(repair=()))
    blocking = [c for c in items[0].clarifications if c.blocks_pricing]
    assert any("repair or a replacement" in c.question for c in blocking)


def test_a_finding_with_no_recommendation_blocks_pricing(tmp_path):
    _, items = _scope(tmp_path, Problem(repair_text="", repair=("Repair Equipment",)))
    assert any(c.blocks_pricing and "actually need" in c.question
               for c in items[0].clarifications)


# -- constraints and exclusions ------------------------------------------


def test_an_outage_becomes_an_access_constraint_not_a_price_decision(tmp_path):
    """Knowing what 'de-energise' implies is domain knowledge, so it stays here."""
    _, items = _scope(tmp_path, Problem(
        repair_text="This will require a shutdown to complete safely",
        repair=("Repair Equipment",)))
    assert OUTAGE_CONSTRAINT in items[0].access_constraints


def test_work_already_done_is_carried_but_not_priced(tmp_path):
    _, items = _scope(tmp_path, Problem(corrected=True))
    assert items[0].excluded_reason
    assert not items[0].priceable
    assert items[0].asset_id, "it is still visible, with its tag"


def test_corrected_work_can_be_included_when_asked(tmp_path):
    _, items = _scope(tmp_path, Problem(corrected=True), include_corrected=True)
    assert not items[0].excluded_reason


# -- evidence survives the crossing --------------------------------------


def test_every_scope_item_carries_the_page_it_came_from(tmp_path):
    _, items = _scope(tmp_path, Problem(), Problem(tag_id="01002"))
    for item in items:
        assert item.evidence, "an item with no evidence cannot be checked"
        assert item.evidence[0].may_price
        assert "page" in item.evidence[0].locator


def test_a_page_the_parser_could_not_read_becomes_a_question(tmp_path):
    _, items = _scope(tmp_path, Problem(orphan_tick=(300.0, 200.0)))
    assert any("by hand" in c.question for c in items[0].clarifications)


# -- end to end -----------------------------------------------------------


def test_a_priced_item_names_the_config_key_behind_every_number(tmp_path):
    source, _ = _scope(tmp_path, Problem(
        repair=("Repair Equipment",), equipment_type="Switchgear - Vertical Section"))
    estimate = price(source, _card()).estimate
    item = [i for i in estimate.priced_scope if not i.ancillary][0]
    assert item.lines
    for line in item.lines:
        assert line.rate_provenance.kind.value == "configuration"


def test_an_item_with_no_work_type_is_not_described_by_its_own_prose(tmp_path):
    """The engine once turned a whole recommendation sentence into a work type."""
    source, _ = _scope(tmp_path, Problem(
        repair=(), repair_text="Relocate other equipment to dedicated space"))
    result = price(source, _card())
    assert result.unmatched == [], "prose must never become vocabulary"
    questions = [c.question for c in result.estimate.open_questions]
    assert not any("Relocate other equipment" in q for q in questions)
