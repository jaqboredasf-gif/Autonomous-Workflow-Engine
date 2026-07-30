"""Validation, including the checks that exist to stop a dishonest claim."""

from __future__ import annotations

from pathlib import Path

import pytest

from tegg import mockportal, validate


@pytest.fixture
def good_pdf(tmp_path) -> Path:
    path = tmp_path / "EDSAllProblems.pdf"
    path.write_bytes(mockportal.make_pdf(mockportal.BY_KEY["eds_all_problems"]))
    return path


# --- file-level ------------------------------------------------------------


def test_a_missing_file_fails_every_file_check(tmp_path):
    absent = tmp_path / "nope.pdf"
    assert not validate.exists(absent).passed
    assert not validate.non_empty(absent).passed
    assert not validate.is_pdf(absent).passed


def test_none_is_treated_as_absent_rather_than_crashing():
    assert not validate.exists(None).passed
    assert not validate.is_pdf(None).passed


def test_an_empty_file_is_caught_before_anything_tries_to_open_it(tmp_path):
    path = tmp_path / "empty.pdf"
    path.write_bytes(b"")
    assert not validate.non_empty(path).passed


def test_an_html_error_page_named_pdf_is_caught_by_the_magic_bytes(tmp_path):
    # The single most common real failure: SSRS serves an error page with a PDF
    # content type. Only the first five bytes tell the truth.
    path = tmp_path / "report.pdf"
    path.write_bytes(b"<html><body>Server Error</body></html>")
    check = validate.is_pdf(path)
    assert not check.passed
    assert "<html" in check.detail


def test_a_real_pdf_opens_and_reports_its_pages(good_pdf):
    check, pages = validate.pdf_opens(good_pdf)
    assert check.passed
    assert pages == mockportal.BY_KEY["eds_all_problems"].pages


def test_a_truncated_pdf_fails_to_open(tmp_path, good_pdf):
    path = tmp_path / "truncated.pdf"
    path.write_bytes(good_pdf.read_bytes()[:200])
    check, pages = validate.pdf_opens(path)
    assert not check.passed
    assert pages == 0


@pytest.mark.parametrize(
    "pages, low, high, ok",
    [(3, 1, 5000, True), (0, 1, 10, False), (11, 1, 10, False), (1, 1, 1, True)],
)
def test_page_count_is_checked_against_the_expected_range(pages, low, high, ok):
    assert (
        validate.page_count_plausible(pages, minimum=low, maximum=high).passed is ok
    )


def test_the_filename_convention_is_checked_exactly(tmp_path, good_pdf):
    assert validate.filename_convention(good_pdf, "EDSAllProblems.pdf").passed
    assert not validate.filename_convention(good_pdf, "SomethingElse.pdf").passed


# --- text-level ------------------------------------------------------------


def test_required_text_reports_the_field_that_is_absent(good_pdf):
    text = validate.extract_text(good_pdf)
    checks = validate.required_text(
        text, {"site": mockportal.SITE, "customer": "Nobody Incorporated"}
    )
    by_name = {c.name: c for c in checks}
    assert by_name["text_has_site"].passed
    assert not by_name["text_has_customer"].passed


@pytest.mark.parametrize(
    "sample", ["{{customer}}", "<<SITE>>", "TODO: price", "TBD_", "PLACEHOLDER"]
)
def test_each_placeholder_shape_is_caught(sample):
    assert not validate.no_placeholders(f"Report body {sample} end").passed


def test_clean_text_reports_no_placeholders():
    assert validate.no_placeholders("A perfectly ordinary report body.").passed


def test_the_malformed_export_is_caught_only_by_the_text_pass(tmp_path):
    # The fault case's PDF is structurally perfect -- it opens, it has pages,
    # its magic bytes are right. This asserts that the text pass is what
    # catches it, which is the reason that pass exists.
    path = tmp_path / "EDSAllProblems.pdf"
    path.write_bytes(
        mockportal.make_pdf(mockportal.BY_KEY["eds_all_problems"], malformed=True)
    )
    assert validate.is_pdf(path).passed
    assert validate.pdf_opens(path)[0].passed
    assert not validate.no_placeholders(validate.extract_text(path)).passed


def test_identifier_preserved_is_advisory_when_there_is_no_identifier():
    check = validate.identifier_preserved("some text", "")
    assert check.passed
    assert check.severity == validate.ADVISORY


def test_report_type_mismatch_names_both_types():
    check = validate.report_type_selected("eds_all_problems", "problem_count_summary")
    assert not check.passed
    assert "eds_all_problems" in check.detail
    assert "problem_count_summary" in check.detail


# --- honesty ---------------------------------------------------------------


def test_a_credential_in_an_artifact_is_caught_and_the_file_named(tmp_path):
    secret = "not-a-real-password-7c1a"
    path = tmp_path / "leaky.txt"
    path.write_text(f"password={secret}\n", encoding="utf-8")
    check = validate.no_secrets([path], [secret])
    assert not check.passed
    assert "leaky.txt" in check.detail


def test_the_secret_value_never_appears_in_the_check_detail(tmp_path):
    secret = "not-a-real-password-7c1a"
    path = tmp_path / "leaky.txt"
    path.write_text(secret, encoding="utf-8")
    check = validate.no_secrets([path], [secret])
    assert secret not in check.detail
    assert secret not in str(check.to_dict())


def test_a_secret_is_found_regardless_of_case(tmp_path):
    path = tmp_path / "leaky.txt"
    path.write_text("PASSWORD: NotARealSecret99", encoding="utf-8")
    assert not validate.no_secrets([path], ["notarealsecret99"]).passed


def test_a_too_short_secret_is_not_searched_because_it_would_match_anything():
    # Otherwise every artifact "leaks" and the check stops meaning anything.
    check = validate.no_secrets([], ["ab"])
    assert check.passed
    assert "no secret values" in check.detail


def test_clean_artifacts_pass_the_secret_scan(good_pdf):
    assert validate.no_secrets([good_pdf], ["not-a-real-password-7c1a"]).passed


def test_a_final_label_while_blocked_is_refused():
    check = validate.not_final_while_blocked(
        "FINAL - TEGG_Report.pdf", finalization_blocked=True
    )
    assert not check.passed


def test_a_final_label_is_fine_when_nothing_is_blocked():
    assert validate.not_final_while_blocked(
        "FINAL - TEGG_Report.pdf", finalization_blocked=False
    ).passed


def test_a_draft_label_is_fine_while_blocked():
    assert validate.not_final_while_blocked(
        "DRAFT - TEGG_Report.pdf", finalization_blocked=True
    ).passed


def test_review_must_be_declared_when_it_is_expected():
    assert not validate.human_review_declared([], expected=True).passed
    assert validate.human_review_declared(["unticked boxes"], expected=True).passed


def test_review_declared_when_none_was_expected_is_also_a_mismatch():
    assert not validate.human_review_declared(["surprise"], expected=False).passed


# --- the composite ---------------------------------------------------------


def test_a_good_artifact_passes_the_composite(good_pdf):
    report = validate.check_pdf_artifact(
        good_pdf,
        expected_filename="EDSAllProblems.pdf",
        expected_type="eds_all_problems",
        actual_type="eds_all_problems",
        fields={"site": mockportal.SITE},
        min_pages=1,
        max_pages=50,
        secrets=["not-a-real-password-7c1a"],
    )
    assert report.ok, report.reasons()


def test_the_composite_reports_every_required_failure_at_once(tmp_path):
    path = tmp_path / "WrongName.pdf"
    path.write_bytes(b"<html>error</html>")
    report = validate.check_pdf_artifact(
        path,
        expected_filename="EDSAllProblems.pdf",
        expected_type="eds_all_problems",
        actual_type="problem_count_summary",
        fields={},
        min_pages=1,
        max_pages=50,
        secrets=[],
    )
    assert not report.ok
    names = {c.name for c in report.required_failures}
    assert "is_pdf" in names
    assert len(names) >= 2
    assert report.reasons()


def test_advisory_failures_do_not_fail_the_report(good_pdf):
    report = validate.check_pdf_artifact(
        good_pdf,
        expected_filename="EDSAllProblems.pdf",
        expected_type="eds_all_problems",
        actual_type="eds_all_problems",
        fields={},
        min_pages=1,
        max_pages=50,
        secrets=[],
    )
    assert report.ok
    assert all(c.severity == validate.ADVISORY for c in report.advisory_failures)


def test_the_composite_serialises_for_the_result_file(good_pdf):
    data = validate.check_pdf_artifact(
        good_pdf,
        expected_filename="EDSAllProblems.pdf",
        expected_type="eds_all_problems",
        actual_type="eds_all_problems",
        fields={},
        min_pages=1,
        max_pages=50,
        secrets=[],
    ).to_dict()
    assert data["ok"] is True
    assert data["checks"]
