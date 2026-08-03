"""Recommendations, estimates, and the things they must refuse to claim.

The subject here is not arithmetic. It is whether the output can mislead: by
inventing advice, by pricing something it does not understand, by presenting a
placeholder rate as money, or by dropping an item it could not handle.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

pytest.importorskip("pypdf")
pytest.importorskip("reportlab")
pytest.importorskip("yaml")

from awe_tegg import estimate as E                          # noqa: E402
from awe_tegg import findings as F                          # noqa: E402
from awe_tegg import recommend as R                         # noqa: E402
from awe_tegg import review as V                            # noqa: E402
from awe_tegg.visit_operation import choose_visit, validate  # noqa: E402

from mock_reports import Problem, write_equipment_item_problems  # noqa: E402

REAL_CARD = """
rate_card:
  currency: "USD"
  placeholder: false
  labour_rate_per_hour: 100.0
  shutdown_premium_hours: 2.0
  minimum_hours: 2.0
  uncertainty: {default: 0.2}
  work:
    repair:
      default: {labour_hours: 4.0, material_allowance: 100.0}
    replace:
      default: {labour_hours: 8.0, material_allowance: 1000.0}
"""

NARROW_CARD = """
rate_card:
  placeholder: false
  labour_rate_per_hour: 100.0
  uncertainty: {default: 0.2}
  work:
    repair:
      by_equipment:
        "Switchgear": {labour_hours: 6.0, material_allowance: 400.0}
"""


def _findings(tmp_path, problems):
    path = write_equipment_item_problems(tmp_path / "eip.pdf", problems)
    return F.build(equipment_item_problems=path, site_visit="T-1")


def _card(tmp_path, text, name="card.yaml"):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return E.RateCard.load(path)


# -- recommendations ------------------------------------------------------


def test_the_recommendation_is_the_technicians_words_not_a_paraphrase(tmp_path):
    findings = _findings(tmp_path, [
        Problem(repair_text="Torque all connections to manufacturer specification")
    ])
    recommendation = R.recommend(findings).recommendations[0]
    assert "Torque all connections to manufacturer specification" in " ".join(
        recommendation.technician_recommendation
    )


@pytest.mark.parametrize(
    "problem, expected",
    [
        (Problem(corrected=True), "closed"),
        (Problem(severity="Critical"), "immediate"),
        (Problem(severity="Severe"), "immediate"),
        (Problem(severity="Alert", consequences=("Fire Hazard",)), "high"),
        (Problem(severity="Alert", consequences=("Equipment Failure",)), "scheduled"),
        (Problem(severity="Alert", consequences=()), "monitor"),
    ],
)
def test_urgency_follows_the_stated_rule_and_says_which_clause_fired(
    tmp_path, problem, expected
):
    recommendation = R.recommend(_findings(tmp_path, [problem])).recommendations[0]
    assert recommendation.urgency == expected
    assert any(line.startswith("urgency:") for line in recommendation.rationale)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("This will require a shutdown", True),
        ("De-energize the circuit first", True),
        ("Clean the contacts and re-install", False),
    ],
)
def test_an_outage_is_claimed_only_when_the_repair_text_says_so(
    tmp_path, text, expected
):
    recommendation = R.recommend(
        _findings(tmp_path, [Problem(repair_text=f"{text} and then finish the work")])
    ).recommendations[0]
    assert recommendation.requires_shutdown is expected


def test_every_recommendation_is_marked_as_needing_review(tmp_path):
    for recommendation in R.recommend(_findings(tmp_path, [Problem(), Problem()])).recommendations:
        assert recommendation.review_required is True
        assert recommendation.evidence, "a line with no citation is unusable"


def test_neither_box_ticked_is_reported_rather_than_assumed(tmp_path):
    recommendation = R.recommend(
        _findings(tmp_path, [Problem(repair=())])
    ).recommendations[0]
    assert recommendation.work_type == ""
    assert any("repair or replace" in w for w in recommendation.warnings)


# -- estimates ------------------------------------------------------------


def test_a_placeholder_card_stamps_every_total_not_priced(tmp_path):
    card = E.RateCard.load("config/estimating.example.yaml")
    assert card.placeholder is True
    result = E.estimate(R.recommend(_findings(tmp_path, [Problem()])), card)
    assert result.status == E.NOT_PRICED
    assert any("placeholder" in w.lower() for w in result.warnings)
    assert any("placeholder" in a.lower() for a in result.assumptions)


def test_the_range_is_ordered_and_the_expected_value_sits_inside_it(tmp_path):
    card = _card(tmp_path, REAL_CARD)
    result = E.estimate(R.recommend(_findings(tmp_path, [Problem()])), card)
    line = result.priced_lines[0]
    assert line.total["low"] <= line.total["expected"] <= line.total["high"]
    assert line.total["low"] > 0


def test_an_outage_adds_the_cards_premium_and_says_it_did(tmp_path):
    card = _card(tmp_path, REAL_CARD)
    plain = E.estimate(R.recommend(_findings(tmp_path, [
        Problem(repair_text="Clean the contacts and re-install the cover")])), card)
    outage = E.estimate(R.recommend(_findings(tmp_path, [
        Problem(repair_text="This will require a shutdown to complete safely")])), card)

    assert (outage.priced_lines[0].labour_hours["expected"]
            - plain.priced_lines[0].labour_hours["expected"]) == card.shutdown_premium_hours
    assert any("shutdown premium" in a for a in outage.priced_lines[0].assumptions)


def test_work_the_card_does_not_cover_is_listed_unpriced_never_approximated(tmp_path):
    """The failure mode this prevents: pricing a switchboard off the switchgear row."""
    card = _card(tmp_path, NARROW_CARD)
    result = E.estimate(R.recommend(_findings(tmp_path, [
        Problem(equipment_type="Transformer, dry type", repair=("Repair Equipment",)),
    ])), card)
    line = result.lines[0]
    assert not line.priced
    assert "no row matching" in line.not_priced_reason
    assert line.total == {}


def test_an_item_fixed_on_the_visit_is_listed_but_not_sold_again(tmp_path):
    card = _card(tmp_path, REAL_CARD)
    result = E.estimate(R.recommend(_findings(tmp_path, [Problem(corrected=True)])), card)
    assert len(result.lines) == 1
    assert not result.priced_lines
    assert "corrected during the visit" in result.lines[0].not_priced_reason


def test_a_missing_rate_card_is_an_error_with_the_command_to_fix_it(tmp_path):
    with pytest.raises(E.RateCardError) as caught:
        E.RateCard.load(tmp_path / "nope.yaml")
    assert "estimating.example.yaml" in str(caught.value)


def test_every_priced_line_carries_its_assumptions_and_its_source(tmp_path):
    card = _card(tmp_path, REAL_CARD)
    result = E.estimate(R.recommend(_findings(tmp_path, [Problem()])), card)
    line = result.priced_lines[0]
    assert line.assumptions and line.evidence
    assert any("rate card row" in a for a in line.assumptions)


# -- validation -----------------------------------------------------------


def test_validation_passes_a_well_formed_result(tmp_path):
    findings = _findings(tmp_path, [Problem(), Problem(corrected=True)])
    recommendations = R.recommend(findings)
    result = E.estimate(recommendations, _card(tmp_path, REAL_CARD))
    assert validate(findings, recommendations, result)["fatal"] == []


def test_validation_refuses_a_priced_result_built_on_placeholder_rates(tmp_path):
    findings = _findings(tmp_path, [Problem()])
    recommendations = R.recommend(findings)
    result = E.estimate(recommendations, E.RateCard.load("config/estimating.example.yaml"))
    result.status = "DRAFT"                 # as if somebody removed the stamp
    problems = validate(findings, recommendations, result)
    assert any("NOT PRICED" in p for p in problems["fatal"])


def test_validation_refuses_a_recommendation_with_no_citation(tmp_path):
    findings = _findings(tmp_path, [Problem()])
    recommendations = R.recommend(findings)
    recommendations.recommendations[0].evidence = []
    result = E.estimate(recommendations, _card(tmp_path, REAL_CARD))
    assert any("no source citation" in p
               for p in validate(findings, recommendations, result)["fatal"])


def test_validation_refuses_a_result_that_lost_an_item_on_the_way(tmp_path):
    findings = _findings(tmp_path, [Problem(tag_id="1"), Problem(tag_id="2")])
    recommendations = R.recommend(findings)
    del recommendations.recommendations[0]
    result = E.estimate(recommendations, _card(tmp_path, REAL_CARD))
    assert validate(findings, recommendations, result)["fatal"]


# -- choosing the visit ---------------------------------------------------

VISITS = [
    {"identifier": "T25-100", "agreement": "A", "site": "S", "status": "Completed",
     "end_date": "1/6/2026", "start_date": "12/1/2025"},
    {"identifier": "T26-001", "agreement": "A", "site": "S", "status": "Completed",
     "end_date": "8/31/2026", "start_date": "6/1/2026"},
    {"identifier": "T26-002", "agreement": "A", "site": "S", "status": "Completed",
     "end_date": "8/31/2026", "start_date": "6/19/2026"},
    {"identifier": "T26-003", "agreement": "", "site": "S", "status": "Completed",
     "end_date": "9/30/2026", "start_date": "7/1/2026"},
    {"identifier": "T26-004", "agreement": "A", "site": "S", "status": "Incomplete",
     "end_date": "9/30/2026", "start_date": "7/1/2026"},
]


def test_the_standing_rule_picks_the_same_visit_every_time():
    first, why = choose_visit(VISITS)
    again, _ = choose_visit(list(reversed(VISITS)))
    assert first["identifier"] == again["identifier"] == "T26-002"
    assert "standing rule" in why


def test_a_visit_with_no_agreement_or_not_completed_is_not_eligible():
    chosen, _ = choose_visit(VISITS)
    assert chosen["identifier"] not in ("T26-003", "T26-004")


def test_an_explicit_identifier_wins_and_says_so():
    chosen, why = choose_visit(VISITS, "T25-100")
    assert chosen["identifier"] == "T25-100"
    assert "explicitly" in why


def test_an_identifier_that_is_not_there_lists_what_is():
    from awe_tegg.operation import Escalated

    with pytest.raises(Escalated) as caught:
        choose_visit(VISITS, "T99-999")
    assert "T26-002" in str(caught.value)


def test_nothing_eligible_is_an_escalation_not_an_empty_result():
    from awe_tegg.operation import Escalated

    with pytest.raises(Escalated):
        choose_visit([{"identifier": "X", "status": "Incomplete"}])


# -- the coworker's page --------------------------------------------------


def test_the_review_leads_with_the_draft_banner_and_cites_every_item(tmp_path):
    findings = _findings(tmp_path, [Problem(tag_id="01001"), Problem(tag_id="01002")])
    recommendations = R.recommend(findings)
    result = E.estimate(recommendations, E.RateCard.load("config/estimating.example.yaml"))
    review = V.build(findings, recommendations, result, run_id="r1")

    head = review.markdown.split("## ")[0]
    assert "DRAFT" in head and "NOT A QUOTATION" in head
    assert "not real" in head, "placeholder rates must be flagged above the fold"
    assert "Equipment Item Problems Report, page 1" in review.markdown
    assert "did not submit, approve, email, upload or change anything" in review.markdown
    for tag in ("01001", "01002"):
        assert tag in review.markdown


def test_the_review_writes_both_a_page_and_the_data_behind_it(tmp_path):
    findings = _findings(tmp_path, [Problem()])
    recommendations = R.recommend(findings)
    result = E.estimate(recommendations, E.RateCard.load("config/estimating.example.yaml"))
    written = V.build(findings, recommendations, result).write(tmp_path / "out")
    assert written["markdown"].exists() and written["json"].exists()

    import json

    payload = json.loads(written["json"].read_text(encoding="utf-8"))
    assert payload["estimate"]["status"] == E.NOT_PRICED
    assert payload["recommendations"]["disclaimer"].startswith("DRAFT")
