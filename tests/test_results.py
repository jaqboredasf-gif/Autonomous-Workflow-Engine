"""The three-status result, and the contradiction it exists to prevent."""

from __future__ import annotations

import json

from tegg import results


def test_a_fresh_result_claims_nothing():
    result = results.ReportResult(report_id="pcs")
    assert result.generation_status == results.NOT_ATTEMPTED
    assert not result.ok


def test_ok_needs_generation_and_validation_and_no_failure():
    result = results.ReportResult(report_id="pcs")
    result.generation_status = results.COMPLETED
    result.validation_status = results.PASSED
    assert result.ok


def test_human_review_does_not_make_a_section_unusable():
    # A section needing a human makes the *report* a draft. The section itself
    # is still fine to merge, which is why ok/ review_status are separate.
    result = results.ReportResult(report_id="certificate")
    result.generation_status = results.COMPLETED
    result.validation_status = results.PASSED
    result.require_human_review("a human must tick section B")
    assert result.ok
    assert result.review_status == results.HUMAN_REVIEW_REQUIRED


def test_blocking_finalization_also_requires_review():
    result = results.ReportResult(report_id="certificate")
    result.block_finalization("checkboxes cannot be set automatically")
    assert result.finalization_status == results.BLOCKED
    assert result.review_status == results.HUMAN_REVIEW_REQUIRED
    assert result.blocker


def test_the_same_review_reason_is_not_recorded_twice():
    result = results.ReportResult(report_id="certificate")
    result.require_human_review("same reason")
    result.require_human_review("same reason")
    assert result.human_review == ["same reason"]


def test_ready_while_review_is_outstanding_is_a_contradiction():
    # This is the check the whole module exists for.
    result = results.ReportResult(report_id="certificate")
    result.generation_status = results.COMPLETED
    result.validation_status = results.PASSED
    result.review_status = results.HUMAN_REVIEW_REQUIRED
    result.human_review.append("section B is unticked")
    problems = result.consistent()
    assert problems
    assert "finalization_status" in problems[0]


def test_blocked_without_a_named_blocker_is_a_contradiction():
    result = results.ReportResult(report_id="certificate")
    result.finalization_status = results.BLOCKED
    assert any("no blocker is named" in p for p in result.consistent())


def test_failed_without_a_reason_is_a_contradiction():
    result = results.ReportResult(report_id="pcs")
    result.generation_status = results.FAILED
    assert any("no reason is recorded" in p for p in result.consistent())


def test_completed_while_carrying_a_failure_reason_is_a_contradiction():
    result = results.ReportResult(report_id="pcs")
    result.generation_status = results.COMPLETED
    result.failure_reason = "the export served HTML"
    assert any("but a failure" in p for p in result.consistent())


def test_a_correctly_blocked_certificate_is_consistent():
    result = results.ReportResult(report_id="certificate")
    result.generation_status = results.COMPLETED
    result.validation_status = results.PASSED
    result.block_finalization("signature cannot be automated")
    assert result.consistent() == []


def test_fail_records_the_reason_and_the_root_cause():
    result = results.ReportResult(report_id="pcs")
    result.fail("no PDF response arrived", root_cause="export/pdf_never_arrived")
    assert result.generation_status == results.FAILED
    assert result.root_cause == "export/pdf_never_arrived"
    assert result.consistent() == []


def test_a_result_survives_a_round_trip_through_a_dict():
    result = results.ReportResult(report_id="pcs", canonical_type="problem_count")
    result.block_finalization("needs a human")
    restored = results.ReportResult.from_dict(result.to_dict())
    assert restored == result


def test_from_dict_ignores_fields_it_does_not_know():
    restored = results.ReportResult.from_dict(
        {"report_id": "pcs", "invented_field": 1}
    )
    assert restored.report_id == "pcs"


def test_run_report_counts_and_groups():
    report = results.RunReport(job_id="mock-job")
    good = report.add(results.ReportResult(report_id="pcs"))
    good.generation_status = results.COMPLETED
    good.validation_status = results.PASSED
    cert = report.add(results.ReportResult(report_id="certificate"))
    cert.generation_status = results.COMPLETED
    cert.validation_status = results.PASSED
    cert.block_finalization("needs a signature")
    bad = report.add(results.ReportResult(report_id="eds"))
    bad.fail("the export served HTML")

    counts = report.counts()
    assert counts == {
        "total": 3,
        "passed": 2,
        "failed": 1,
        "human_review_required": 1,
        "finalization_blocked": 1,
    }
    assert [r.report_id for r in report.failures] == ["eds"]
    assert [r.report_id for r in report.blocked] == ["certificate"]
    assert report.inconsistencies() == []


def test_run_report_surfaces_a_contradiction_from_any_section():
    report = results.RunReport()
    broken = report.add(results.ReportResult(report_id="certificate"))
    broken.review_status = results.HUMAN_REVIEW_REQUIRED
    broken.human_review.append("unticked")
    assert report.inconsistencies()


def test_write_produces_readable_json_with_the_counts(tmp_path):
    report = results.RunReport(job_id="mock-job")
    report.add(results.ReportResult(report_id="pcs"))
    path = report.write(tmp_path / "nested" / "result.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["job_id"] == "mock-job"
    assert data["counts"]["total"] == 1
    assert data["results"][0]["report_id"] == "pcs"
    assert data["finished_at"]
