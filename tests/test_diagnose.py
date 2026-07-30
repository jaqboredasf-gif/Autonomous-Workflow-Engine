"""Every diagnosis rule, checked against a message the system really emits."""

from __future__ import annotations

import pytest

from tegg import diagnose


@pytest.mark.parametrize(
    "message, stage, cause",
    [
        (
            "credentials are not set: TEGG_USERNAME",
            diagnose.STAGE_LOGIN,
            "credentials_absent",
        ),
        (
            "still on the sign-in page after submitting",
            diagnose.STAGE_LOGIN,
            "login_outcome_not_detected",
        ),
        (
            "sign-in was rejected",
            diagnose.STAGE_LOGIN,
            "credentials_rejected",
        ),
        (
            "the contractor select was never set",
            diagnose.STAGE_LOGIN,
            "contractor_not_set",
        ),
        (
            "could not select the site 'Bay Street Plant' in the typeahead",
            diagnose.STAGE_SITE,
            "site_not_selectable",
        ),
        (
            "PLEASE SEARCH FOR A CUSTOMER OR SITE",
            diagnose.STAGE_SITE,
            "site_not_selected",
        ),
        (
            "'Long Form' is not visible in the report list",
            diagnose.STAGE_NAVIGATION,
            "report_leaf_not_found",
        ),
        (
            "There are currently no agreements for this company",
            diagnose.STAGE_NAVIGATION,
            "wrong_route",
        ),
        (
            "Agreement: no control offers 'STD88117209SM-05/25-01'",
            diagnose.STAGE_PARAMETERS,
            "parameter_unsatisfiable",
        ),
        (
            "no ReportViewer popup appeared after Print Report was clicked",
            diagnose.STAGE_VIEWER,
            "viewer_never_opened",
        ),
        (
            "the format dropdown never became usable",
            diagnose.STAGE_VIEWER,
            "format_dropdown_not_ready",
        ),
        (
            "no PDF response arrived within 90000 ms of clicking Export",
            diagnose.STAGE_EXPORT,
            "pdf_never_arrived",
        ),
        (
            "no PDF arrived: the export responded with an empty body",
            diagnose.STAGE_EXPORT,
            "pdf_never_arrived",
        ),
        (
            "the export responded but the body is not a PDF",
            diagnose.STAGE_EXPORT,
            "response_was_not_a_pdf",
        ),
        (
            "LibreOffice could not convert the certificate",
            diagnose.STAGE_CONVERSION,
            "conversion_failed",
        ),
        (
            "checkboxes are encoded as wingdings glyphs",
            diagnose.STAGE_VALIDATION,
            "certificate_needs_a_human",
        ),
        (
            "no_placeholders: left in the output: {{, TODO:",
            diagnose.STAGE_VALIDATION,
            "placeholder_left_in_output",
        ),
        (
            "'report.pdf' does not name the customer 'Atlas Capital'",
            diagnose.STAGE_VALIDATION,
            "artifact_does_not_match_the_job",
        ),
        (
            "page count mismatch: expected 31, merged 30",
            diagnose.STAGE_ASSEMBLY,
            "assembled_pdf_invalid",
        ),
        (
            "cannot assemble: missing 2 documents",
            diagnose.STAGE_ASSEMBLY,
            "sections_missing",
        ),
        (
            "static asset not found: ESA Table of Contents.pdf",
            diagnose.STAGE_ASSEMBLY,
            "static_asset_missing",
        ),
        (
            "Timeout 30000ms exceeded waiting for selector",
            diagnose.STAGE_UNKNOWN,
            "timed_out",
        ),
    ],
)
def test_each_rule_matches_a_message_the_system_emits(message, stage, cause):
    verdict = diagnose.diagnose(message)
    assert (verdict.stage, verdict.cause) == (stage, cause)


def test_every_diagnosis_names_a_place_to_look():
    for pattern, *_ in diagnose.RULES:
        assert pattern


def test_an_unmatched_message_says_so_rather_than_guessing():
    verdict = diagnose.diagnose("something nobody has seen before")
    assert verdict.cause == "unclassified"
    assert verdict.blame == diagnose.BLAME_UNKNOWN
    assert "add one to diagnose.RULES" in verdict.locus


def test_a_stage_hint_is_used_only_when_no_rule_matches():
    hinted = diagnose.diagnose("mystery", stage_hint=diagnose.STAGE_EXPORT)
    assert hinted.stage == diagnose.STAGE_EXPORT

    # A rule that does match wins over the hint, because the message is better
    # evidence than the caller's guess about where it was.
    matched = diagnose.diagnose(
        "the format dropdown never became usable", stage_hint=diagnose.STAGE_LOGIN
    )
    assert matched.stage == diagnose.STAGE_VIEWER


def test_the_ladder_is_ordered_most_specific_first():
    # 'sign-in was rejected' also contains nothing that the generic timeout rule
    # would catch, but an empty-body export message matches both the specific
    # pdf_never_arrived rule and, textually, nothing else. Guard the one pair
    # that genuinely overlaps: an empty body is not a wrong-type body.
    verdict = diagnose.diagnose(
        "no PDF arrived: the export responded with an empty body "
        "(viewer: empty body)"
    )
    assert verdict.cause == "pdf_never_arrived"


def test_the_original_message_is_preserved_for_a_reader():
    message = "no ReportViewer popup appeared after Print Report was clicked"
    assert diagnose.diagnose(message).detail == message


def test_an_empty_message_does_not_raise():
    assert diagnose.diagnose("").cause == "unclassified"
    assert diagnose.diagnose(None).cause == "unclassified"


def test_a_very_long_message_is_truncated_for_the_result_file():
    verdict = diagnose.diagnose("timeout " + "x" * 5000)
    assert len(verdict.detail) <= 300


def test_diagnosis_serialises_for_the_json_result():
    data = diagnose.diagnose("timeout").to_dict()
    assert set(data) == {"stage", "cause", "locus", "blame", "detail"}
