"""The TEGG visit pipeline, end to end, offline.

Findings -> recommendations -> scope -> price -> confidence -> review. Every
stage is deterministic and none of it needs a portal, so the whole thing is
exercised here from synthetic reports.
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

pytest.importorskip("pypdf")
pytest.importorskip("reportlab")

from awe_estimating import Confidence, price                    # noqa: E402
from awe_estimating.confidence import apply as apply_confidence  # noqa: E402
from awe_estimating.ratecard import RateCard                    # noqa: E402
from awe_tegg import findings as F                              # noqa: E402
from awe_tegg import recommend as R                             # noqa: E402
from awe_tegg import review as V                                # noqa: E402
from awe_tegg.scope_adapter import from_recommendations         # noqa: E402
from awe_tegg.visit_operation import validate                   # noqa: E402

from mock_reports import Problem, write_equipment_item_problems  # noqa: E402

REPAIRABLE = dict(repair=("Repair Equipment",),
                  equipment_type="Switchgear - Vertical Section",
                  repair_text="Clean and re-terminate the connection")


def _pipeline(tmp_path, *problems, production=True, include_corrected=False):
    path = write_equipment_item_problems(tmp_path / "eip.pdf", list(problems))
    findings = F.build(equipment_item_problems=path, site_visit="T-1",
                       customer="Acme", site="Plant 3")
    recommendations = R.recommend(findings)
    source = from_recommendations(recommendations, customer="Acme", site="Plant 3",
                                  site_visit="T-1",
                                  include_corrected=include_corrected)
    card = RateCard.load("config/ratecard.example.yaml")
    if production:
        card.placeholder = False
        card.name, card.version = "Test Card", "1.0"
    result = price(source, card)
    confidence = apply_confidence(result.estimate)
    return findings, recommendations, result, confidence


def test_the_whole_pipeline_produces_a_priced_estimate(tmp_path):
    _, _, result, confidence = _pipeline(tmp_path, Problem(**REPAIRABLE))
    assert result.estimate.total > Decimal("0")
    assert confidence.level is not Confidence.INSUFFICIENT


def test_nothing_is_lost_crossing_from_findings_into_scope(tmp_path):
    findings, recommendations, result, _ = _pipeline(
        tmp_path, Problem(tag_id="01001", **REPAIRABLE),
        Problem(tag_id="01002", **REPAIRABLE))
    assert len(findings.findings) == len(recommendations.recommendations)
    assert len(result.estimate.work_scope) == len(recommendations.recommendations)


def test_internal_consistency_validation_passes_a_good_result(tmp_path):
    findings, recommendations, result, _ = _pipeline(tmp_path, Problem(**REPAIRABLE))
    assert validate(findings, recommendations, result.estimate)["fatal"] == []


def test_validation_catches_an_item_lost_between_stages(tmp_path):
    findings, recommendations, result, _ = _pipeline(
        tmp_path, Problem(tag_id="01001", **REPAIRABLE),
        Problem(tag_id="01002", **REPAIRABLE))
    del result.estimate.scope[0]
    problems = validate(findings, recommendations, result.estimate)["fatal"]
    assert any("nothing may be lost" in p for p in problems)


def test_a_template_card_cannot_produce_an_approved_estimate(tmp_path):
    from awe_estimating.model import ApprovalStatus

    findings, recommendations, result, _ = _pipeline(
        tmp_path, Problem(**REPAIRABLE), production=False)
    result.estimate.approval.status = ApprovalStatus.APPROVED
    problems = validate(findings, recommendations, result.estimate)["fatal"]
    assert any("template rates cannot be approved" in p for p in problems)


def test_work_already_done_is_excluded_and_the_confidence_says_so(tmp_path):
    _, _, result, confidence = _pipeline(tmp_path, Problem(corrected=True, **REPAIRABLE))
    assert result.estimate.total == Decimal("0")
    assert confidence.level is Confidence.INSUFFICIENT
    assert any("nothing to price" in r for r in confidence.reasons)


# -- the coworker's page --------------------------------------------------


def test_the_review_leads_with_the_draft_banner(tmp_path):
    findings, recommendations, result, confidence = _pipeline(
        tmp_path, Problem(**REPAIRABLE), production=False)
    markdown = V.build(findings, recommendations, result.estimate, confidence,
                       run_id="r1").markdown
    head = markdown.split("## ")[0]
    assert "DRAFT" in head and "NOT A QUOTATION" in head
    assert "not real" in head, "a template card must be flagged above the fold"


def test_the_review_never_shows_confidence_without_reasons(tmp_path):
    findings, recommendations, result, confidence = _pipeline(
        tmp_path, Problem(**REPAIRABLE))
    markdown = V.build(findings, recommendations, result.estimate,
                       confidence).markdown
    assert "How much to trust this" in markdown
    for reason in confidence.reasons:
        assert reason in markdown


def test_the_review_shows_how_the_total_was_built(tmp_path):
    findings, recommendations, result, confidence = _pipeline(
        tmp_path, Problem(**REPAIRABLE))
    markdown = V.build(findings, recommendations, result.estimate,
                       confidence).markdown
    assert "How the total is built" in markdown
    assert "direct cost" in markdown and "**total**" in markdown
    assert "Test Card" in markdown, "the card that priced it must be named"


def test_an_unpriced_item_appears_with_its_reason_not_a_number(tmp_path):
    findings, recommendations, result, confidence = _pipeline(
        tmp_path, Problem(repair=()))
    markdown = V.build(findings, recommendations, result.estimate,
                       confidence).markdown
    assert "*not priced" in markdown
    assert "Questions that need answering" in markdown
    assert "blocking" in markdown


def test_every_question_the_tool_asked_reaches_the_page(tmp_path):
    findings, recommendations, result, confidence = _pipeline(
        tmp_path, Problem(description="All fuses are incorrectly matched",
                          **REPAIRABLE))
    markdown = V.build(findings, recommendations, result.estimate,
                       confidence).markdown
    assert any(q.question in markdown for q in result.estimate.open_questions)


def test_the_json_carries_everything_needed_to_recompute(tmp_path):
    findings, recommendations, result, confidence = _pipeline(
        tmp_path, Problem(**REPAIRABLE))
    payload = V.build(findings, recommendations, result.estimate,
                      confidence, run_id="r1").payload
    assert payload["schema_version"] >= 2
    assert payload["estimate"]["total"]
    assert payload["confidence"]["level"] == confidence.level.value
    assert payload["findings"]["schema_version"] >= 1


def test_an_empty_visit_still_renders_a_page(tmp_path):
    from reportlab.pdfgen import canvas

    blank = tmp_path / "eip.pdf"
    pdf = canvas.Canvas(str(blank), pagesize=(612, 792)); pdf.showPage(); pdf.save()
    findings = F.build(equipment_item_problems=blank, site_visit="T-1")
    recommendations = R.recommend(findings)
    card = RateCard.load("config/ratecard.example.yaml")
    result = price(from_recommendations(recommendations), card)
    markdown = V.build(findings, recommendations, result.estimate).markdown
    assert "Nothing to quote" in markdown
