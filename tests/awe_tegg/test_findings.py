"""Reading the inspection reports: the ticks, the text, and the refusals.

The tests that matter here are the ones about *not* answering. A parser that
reports "no fire hazard" because it could not find the tick is worse than one
that says it could not read the page, and the difference is invisible unless
something checks for it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

pytest.importorskip("pypdf")
pytest.importorskip("reportlab")

from awe_tegg import findings as F                          # noqa: E402

from mock_reports import (                                  # noqa: E402
    Problem,
    Sheet,
    write_equipment_item_problems,
    write_standard_ir,
)


@pytest.fixture
def report(tmp_path):
    def build(problems):
        return write_equipment_item_problems(
            tmp_path / "eip.pdf", problems
        )
    return build


# -- the ticks ------------------------------------------------------------


def test_a_tick_is_read_from_where_it_sits_not_from_where_it_is_listed(report):
    """The ``X`` comes before its label in the text stream and after it in some
    sections. Only its position says which box it is in."""
    path = report([
        Problem(
            repair=("Replace Equipment",),
            consequences=("Fire Hazard", "Power/Business Interruption"),
            corrective=("Estimate Required",),
            corrected=True,
        )
    ])
    finding = F.parse_equipment_item_problems(path)[0]

    assert finding.recommendation == {
        "Repair Equipment": False, "Replace Equipment": True,
    }
    assert finding.consequence == {
        "Equipment Failure": False, "Fire Hazard": True,
        "Safety Hazard": False, "Power/Business Interruption": True,
    }
    assert finding.estimate_required is True
    assert finding.problem_corrected is True
    assert finding.warnings == []


def test_an_untouched_page_reports_every_box_as_unticked(report):
    path = report([Problem(repair=(), consequences=(), corrective=(), corrected=False)])
    finding = F.parse_equipment_item_problems(path)[0]
    assert not any(finding.recommendation.values())
    assert not any(finding.consequence.values())
    assert finding.estimate_required is False
    assert finding.warnings == []


def test_a_tick_no_label_can_claim_makes_the_page_untrustworthy(report):
    """Something was ticked and we cannot say what. That is not a clean parse."""
    path = report([Problem(orphan_tick=(300.0, 200.0))])
    finding = F.parse_equipment_item_problems(path)[0]

    assert finding.warnings, "an unclaimed tick must be reported"
    assert "matched no checkbox label" in finding.warnings[0]
    assert finding.trustworthy is False


def test_an_unreadable_page_is_still_returned_rather_than_dropped(report):
    """It has to reach the coworker's list, flagged. Silence is the bad case."""
    path = report([Problem(tag_id="01001"), Problem(tag_id="01002",
                                                    orphan_tick=(300.0, 200.0))])
    findings = F.parse_equipment_item_problems(path)
    assert [f.tag_id for f in findings] == ["01001", "01002"]
    assert findings[0].trustworthy and not findings[1].trustworthy


# -- the text -------------------------------------------------------------


def test_the_technicians_repair_text_is_never_truncated_at_a_line_break(report):
    """SSRS pushes a wrapped line past the next heading. It is still the repair."""
    path = report([
        Problem(
            repair_text="Relocate the intrusions to dedicated space to allow safe",
            repair_tail="cover removal",
        )
    ])
    finding = F.parse_equipment_item_problems(path)[0]
    joined = " ".join(finding.narrative)
    assert "Relocate the intrusions" in joined
    assert "cover removal" in joined, "the second line of the instruction was lost"


def test_the_contractors_letterhead_is_not_mistaken_for_the_problem(report):
    """It is the topmost text on the page and it is not a finding."""
    path = report([Problem(description="Multiple conductors under one lug.")])
    finding = F.parse_equipment_item_problems(path)[0]
    assert finding.problem_description == "Multiple conductors under one lug."
    assert "Seventh Street" not in finding.problem_description


def test_the_tag_and_the_customers_own_id_are_separated(report):
    path = report([Problem(tag_id="03303", customer_id="SW #2-6")])
    finding = F.parse_equipment_item_problems(path)[0]
    assert finding.tag_id == "03303"
    assert finding.customer_id == "SW #2-6"


def test_a_pdf_that_is_not_this_report_is_refused_with_a_reason(tmp_path):
    other = write_standard_ir(tmp_path / "ir.pdf", [Sheet()])
    with pytest.raises(F.FindingsError) as caught:
        F.parse_equipment_item_problems(other)
    assert "Equipment Item Problems Report" in str(caught.value)


# -- the infrared measurement --------------------------------------------


def test_the_difference_temperature_is_graded_against_the_reports_own_bands(tmp_path):
    path = write_standard_ir(tmp_path / "ir.pdf", [
        Sheet(tag_id="01001", difference_c=7.8),
        Sheet(tag_id="01002", difference_c=12.0, page_label="3A"),
        Sheet(tag_id="01003", difference_c=19.9, page_label="4A"),
        Sheet(tag_id="01004", difference_c=1.0, page_label="5A"),
    ])
    thermal = F.parse_standard_ir(path)
    assert thermal["01001"].derived_severity == "Alert"
    assert thermal["01002"].derived_severity == "Severe"
    assert thermal["01003"].derived_severity == "Critical"
    assert thermal["01004"].derived_severity == "Normal"


def test_no_severity_is_derived_when_the_report_printed_no_measurement():
    assert F.severity_for(None, {"Alert": "4.1C - 8.0C"}) == ""
    assert F.severity_for(7.8, {}) == ""


# -- putting them together ------------------------------------------------


def test_the_thermal_reading_is_attached_to_the_problem_with_the_same_tag(tmp_path):
    eip = write_equipment_item_problems(tmp_path / "eip.pdf", [
        Problem(tag_id="01001"), Problem(tag_id="09999"),
    ])
    ir = write_standard_ir(tmp_path / "ir.pdf", [Sheet(tag_id="01001", difference_c=7.8)])

    built = F.build(equipment_item_problems=eip, standard_ir=ir, site_visit="T-1")
    by_tag = {f.tag_id: f for f in built.findings}
    assert by_tag["01001"].thermal is not None
    assert by_tag["01001"].thermal.difference_temperature_c == 7.8
    assert by_tag["09999"].thermal is None, "a tag with no sheet gets no reading"


def test_an_ir_report_about_different_equipment_is_flagged_not_ignored(tmp_path):
    eip = write_equipment_item_problems(tmp_path / "eip.pdf", [Problem(tag_id="01001")])
    ir = write_standard_ir(tmp_path / "ir.pdf", [Sheet(tag_id="07777")])

    built = F.build(equipment_item_problems=eip, standard_ir=ir)
    assert any("none of them matched" in w for w in built.warnings)


def test_every_finding_carries_a_checksum_of_the_document_it_came_from(tmp_path):
    eip = write_equipment_item_problems(tmp_path / "eip.pdf", [Problem()])
    built = F.build(equipment_item_problems=eip)
    digest = F.checksum(eip)
    assert built.documents[0]["sha256"] == digest
    assert built.findings[0].source.sha256 == digest
    assert built.findings[0].source.page == 1


def test_the_schema_version_travels_with_the_data(tmp_path):
    eip = write_equipment_item_problems(tmp_path / "eip.pdf", [Problem()])
    built = F.build(equipment_item_problems=eip).to_dict()
    assert built["schema_version"] == F.FINDINGS_SCHEMA_VERSION


# -- a visit with nothing wrong with it -----------------------------------


def _blank_pdf(path: Path, pages: int = 1) -> Path:
    from reportlab.pdfgen import canvas

    pdf = canvas.Canvas(str(path), pagesize=(612, 792))
    for _ in range(pages):
        pdf.showPage()
    pdf.save()
    return path


def test_a_blank_problems_report_is_a_clean_visit_not_a_parse_failure(tmp_path):
    """Nothing wrong with the equipment is a real answer, and a useful one."""
    blank = _blank_pdf(tmp_path / "eip.pdf")
    ir = write_standard_ir(tmp_path / "ir.pdf", [])          # cover only, no sheets

    built = F.build(equipment_item_problems=blank, standard_ir=ir, site_visit="T-1")
    assert built.findings == []
    assert "carried no problems at all" in built.empty_reason
    assert built.to_dict()["empty_reason"]


def test_a_blank_problems_report_is_not_believed_when_the_ir_lists_faults(tmp_path):
    """One document empty and the other full is a retrieval that went wrong."""
    blank = _blank_pdf(tmp_path / "eip.pdf")
    ir = write_standard_ir(tmp_path / "ir.pdf", [Sheet(tag_id="01001")])

    with pytest.raises(F.FindingsError) as caught:
        F.build(equipment_item_problems=blank, standard_ir=ir)
    assert "disagree" in str(caught.value)
    assert not isinstance(caught.value, F.EmptyReport)


def test_a_document_that_is_simply_the_wrong_one_still_says_so(tmp_path):
    """Distinct from blank: this one has content, just not ours."""
    other = write_standard_ir(tmp_path / "ir.pdf", [Sheet()])
    with pytest.raises(F.FindingsError) as caught:
        F.parse_equipment_item_problems(other)
    assert not isinstance(caught.value, F.EmptyReport)
    assert "carries no page headed" in str(caught.value)


def test_no_findings_with_no_reason_is_still_a_failure(tmp_path):
    """The empty-visit path must not become a way to return nothing quietly."""
    from awe_tegg import estimate as E
    from awe_tegg import recommend as R
    from awe_tegg.visit_operation import validate

    built = F.FindingSet(site_visit="T-1")                   # no findings, no reason
    recommendations = R.recommend(built)
    result = E.estimate(recommendations, E.RateCard.load("config/estimating.example.yaml"))
    assert validate(built, recommendations, result)["fatal"]

    built.empty_reason = "the report rendered and carried no problems at all"
    assert validate(built, recommendations, result)["fatal"] == []
