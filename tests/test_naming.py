"""The deliverable filename is a claim, so the checker has to be strict."""

from __future__ import annotations

import pytest

from tegg import naming
from tegg.draft import FILENAME_PREFIX


def test_draft_name_carries_customer_site_and_date():
    name = naming.deliverable_name("Atlas Capital", "The Factory", "2025-07-08")
    assert name == f"{FILENAME_PREFIX}TEGG_Atlas_Capital_The_Factory_2025-07-08.pdf"


def test_final_name_drops_the_draft_prefix():
    name = naming.deliverable_name(
        "Atlas Capital", "The Factory", "2025-07-08", draft=False
    )
    assert not name.startswith(FILENAME_PREFIX)
    assert name.startswith("TEGG_")


def test_punctuation_is_reduced_to_single_underscores():
    name = naming.deliverable_name("O'Brien & Sons, Inc.", "Plant #3", "2026-01-02")
    assert "O_Brien_Sons_Inc" in name
    assert "Plant_3" in name
    assert "__" not in name


@pytest.mark.parametrize("bad", ["08/07/2025", "2025-7-8", "", "July 8 2025"])
def test_a_non_iso_date_is_refused_rather_than_guessed(bad):
    # A misfiled report is worse than a loud failure.
    with pytest.raises(ValueError):
        naming.deliverable_name("Atlas Capital", "The Factory", bad)


def test_a_generated_name_passes_its_own_check():
    name = naming.deliverable_name("Atlas Capital", "The Factory", "2025-07-08")
    verdict = naming.check(
        name,
        customer="Atlas Capital",
        site="The Factory",
        visit_date="2025-07-08",
        expect_draft=True,
    )
    assert verdict.ok, verdict.problems
    assert verdict.is_draft


def test_the_wrong_visit_date_is_reported_not_ignored():
    name = naming.deliverable_name("Atlas Capital", "The Factory", "2025-07-08")
    verdict = naming.check(name, visit_date="2025-07-09")
    assert not verdict.ok
    assert any("2025-07-08" in p and "2025-07-09" in p for p in verdict.problems)


def test_a_name_for_the_wrong_customer_is_reported():
    name = naming.deliverable_name("Atlas Capital", "The Factory", "2025-07-08")
    verdict = naming.check(name, customer="Northwind Manufacturing")
    assert not verdict.ok
    assert any("Northwind" in p for p in verdict.problems)


def test_dropping_draft_while_review_is_outstanding_is_a_problem():
    # This is the honesty check: the prefix is the claim, so removing it while a
    # human still has to sign is exactly the mistake worth catching.
    name = naming.deliverable_name(
        "Atlas Capital", "The Factory", "2025-07-08", draft=False
    )
    verdict = naming.check(name, expect_draft=True)
    assert not verdict.ok
    assert any("outstanding human review" in p for p in verdict.problems)


def test_a_draft_name_is_a_problem_when_the_report_really_is_final():
    name = naming.deliverable_name("Atlas Capital", "The Factory", "2025-07-08")
    verdict = naming.check(name, expect_draft=False)
    assert not verdict.ok


def test_a_foreign_filename_fails_every_structural_rule():
    verdict = naming.check("report.docx", visit_date="2025-07-08")
    assert not verdict.ok
    assert len(verdict.problems) >= 2


def test_check_accepts_a_full_path():
    name = naming.deliverable_name("Atlas Capital", "The Factory", "2025-07-08")
    verdict = naming.check(f"/tmp/whatever/{name}", visit_date="2025-07-08")
    assert verdict.ok, verdict.problems
