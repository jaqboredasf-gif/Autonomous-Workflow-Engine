"""The case file is data, so its loader has to be the strict part.

Every rejection tested here is one a typo could otherwise turn into a section
that silently never ran while the summary said everything passed.
"""

from __future__ import annotations

import pytest
import yaml

from tegg import canonical, mockcases


def _write(tmp_path, body: str):
    # Written verbatim: these fixtures are edited by string surgery in the tests
    # below, and dedenting after that would silently reflow the YAML.
    path = tmp_path / "cases.yaml"
    path.write_text(body, encoding="utf-8")
    return path


MINIMAL = """job:
  customer: Northwind Manufacturing
  site: Bay Street Plant
  agreement: STD00000000XX-01/26-01
  site_visit: T26-001
  visit_date: '2026-03-11'
cases:
  - id: problem_count_summary
    kind: portal_report
    portal_label: Problem Count Summary
"""


# --- the repository's own file ---------------------------------------------


def test_the_shipped_case_file_loads():
    matrix = mockcases.load()
    assert matrix.cases
    assert matrix.faults


def test_the_shipped_case_file_covers_every_section_of_the_business_order():
    assert mockcases.load().missing_types() == []


def test_coverage_is_counted_over_the_business_order_not_every_type():
    # STANDARD_IR is an eleventh canonical type that is fetched and split; it is
    # a source, not a section. Counting it would report eleven of ten.
    matrix = mockcases.load()
    assert len(canonical.BUSINESS_ORDER) == 10
    assert matrix.covered_types() >= set(canonical.BUSINESS_ORDER)


def test_the_certificate_case_declares_its_blocker():
    cert = mockcases.load().case("certificate")
    assert cert.human_review
    assert cert.finalization_blocked
    assert cert.blocker


def test_every_fault_case_names_the_stage_and_cause_it_expects():
    for case in mockcases.load().faults:
        assert case.expect_stage, case.id
        assert case.expect_cause, case.id


def test_the_fault_set_covers_navigation_parameters_viewer_export_and_validation():
    stages = {c.expect_stage for c in mockcases.load().faults}
    assert {
        "report_navigation",
        "parameters",
        "report_viewer",
        "export",
        "validation",
    } <= stages


# --- loading ---------------------------------------------------------------


def test_a_minimal_file_loads_and_defaults_sensibly(tmp_path):
    matrix = mockcases.load(_write(tmp_path, MINIMAL))
    case = matrix.cases[0]
    assert case.canonical_type == "problem_count_summary"
    assert case.expect == mockcases.EXPECT_PASS
    assert not case.should_fail
    assert case.min_pages == 1


def test_the_canonical_type_defaults_to_the_case_id(tmp_path):
    matrix = mockcases.load(_write(tmp_path, MINIMAL))
    assert matrix.cases[0].canonical_type == matrix.cases[0].id


def test_an_absent_file_is_a_case_error_not_an_os_error(tmp_path):
    with pytest.raises(mockcases.CaseError, match="no mock case file"):
        mockcases.load(tmp_path / "nothing.yaml")


def test_invalid_yaml_is_reported_as_a_case_error(tmp_path):
    path = tmp_path / "cases.yaml"
    path.write_text("cases: [unclosed\n", encoding="utf-8")
    with pytest.raises(mockcases.CaseError, match="not valid YAML"):
        mockcases.load(path)


def test_a_top_level_list_is_refused(tmp_path):
    path = tmp_path / "cases.yaml"
    path.write_text("- a\n- b\n", encoding="utf-8")
    with pytest.raises(mockcases.CaseError, match="mapping at the top level"):
        mockcases.load(path)


# --- the rejections that matter --------------------------------------------


def test_an_unknown_kind_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="kind"):
        mockcases.load(
            _write(tmp_path, MINIMAL.replace("kind: portal_report", "kind: magic"))
        )


def test_an_unknown_canonical_type_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="does not exist"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL.replace(
                    "    kind: portal_report",
                    "    kind: portal_report\n    canonical_type: invented",
                ),
            )
        )


def test_an_unknown_fault_name_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="unknown fault"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL.replace(
                    "    kind: portal_report",
                    "    kind: portal_report\n    fault: explode",
                ),
            )
        )


def test_a_portal_report_with_no_label_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="names no label"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL.replace("    portal_label: Problem Count Summary\n", ""),
            )
        )


def test_a_derived_case_with_no_source_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="names no source"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL + "  - id: cover\n    kind: derived\n",
            )
        )


def test_a_derived_case_pointing_at_a_case_that_is_not_here_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="not a case in this file"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL
                + "  - id: cover\n    kind: derived\n"
                + "    derived_from: some_other_run\n",
            )
        )


def test_a_blocker_with_no_stated_reason_is_refused(tmp_path):
    # A blocker nobody can read is not reviewable, which is the whole point.
    with pytest.raises(mockcases.CaseError, match="names no blocker"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL.replace(
                    "    kind: portal_report",
                    "    kind: portal_report\n    finalization_blocked: true",
                ),
            )
        )


def test_a_duplicate_case_id_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="duplicate case id"):
        mockcases.load(_write(tmp_path, MINIMAL + MINIMAL.split("cases:")[1]))


def test_a_fault_case_allowed_to_pass_is_refused(tmp_path):
    # A fault case that may pass proves nothing at all.
    with pytest.raises(mockcases.CaseError, match="proves nothing"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL
                + "faults:\n"
                + "  - id: broken\n"
                + "    kind: portal_report\n"
                + "    canonical_type: problem_count_summary\n"
                + "    portal_label: Problem Count Summary\n"
                + "    fault: no_pdf\n"
                + "    expect: pass\n",
            )
        )


def test_an_unknown_job_field_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="unknown job field"):
        mockcases.load(
            _write(tmp_path, MINIMAL.replace("job:\n", "job:\n  region: north\n", 1))
        )


def test_an_unknown_text_field_is_refused_at_load_time(tmp_path):
    # Caught now rather than five minutes into a run.
    with pytest.raises(mockcases.CaseError, match="unknown job field"):
        mockcases.load(
            _write(
                tmp_path,
                MINIMAL.replace(
                    "    kind: portal_report",
                    "    kind: portal_report\n    text_fields: [inspector]",
                ),
            )
        )


def test_a_case_that_is_not_a_mapping_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="not a mapping"):
        mockcases.load(_write(tmp_path, "job: {}\ncases:\n  - just-a-string\n"))


def test_a_case_with_no_id_is_refused(tmp_path):
    with pytest.raises(mockcases.CaseError, match="has no id"):
        mockcases.load(_write(tmp_path, "job: {}\ncases:\n  - kind: static\n"))


# --- the matrix ------------------------------------------------------------


def test_missing_types_names_what_is_uncovered(tmp_path):
    matrix = mockcases.load(_write(tmp_path, MINIMAL))
    missing = matrix.missing_types()
    assert "problem_count_summary" not in missing
    assert len(missing) == len(canonical.BUSINESS_ORDER) - 1


def test_sections_excludes_cases_that_are_expected_to_fail(tmp_path):
    matrix = mockcases.load(
        _write(
            tmp_path,
            MINIMAL
            + "  - id: equipment_inventory_short\n"
            + "    kind: portal_report\n"
            + "    portal_label: Short Form\n"
            + "    expect: fail\n",
        )
    )
    assert [c.id for c in matrix.sections()] == ["problem_count_summary"]


def test_looking_up_a_case_that_is_not_there_says_so(tmp_path):
    matrix = mockcases.load(_write(tmp_path, MINIMAL))
    with pytest.raises(mockcases.CaseError, match="no case named"):
        matrix.case("nonexistent")


def test_expected_fields_resolve_against_the_job(tmp_path):
    matrix = mockcases.load(
        _write(
            tmp_path,
            MINIMAL.replace(
                "    kind: portal_report",
                "    kind: portal_report\n    text_fields: [site, agreement]",
            ),
        )
    )
    fields = matrix.cases[0].expected_fields(matrix.job)
    assert fields == {
        "site": "Bay Street Plant",
        "agreement": "STD00000000XX-01/26-01",
    }


def test_a_case_serialises_for_the_result_file(tmp_path):
    data = mockcases.load(_write(tmp_path, MINIMAL)).cases[0].to_dict()
    assert data["id"] == "problem_count_summary"
    assert yaml.safe_dump(data)
