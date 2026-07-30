"""The site-visit browser route, driven against a mock portal.

These run a real browser against a real HTTP server. They cannot prove the live
TEGG portal behaves this way -- nothing short of a live run can -- but they do
prove the driver handles the shapes it will meet: a status column, a legacy
.doc download, a dead-end Reports page, and an expired session.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

pytest.importorskip("playwright")

from mock_sitevisit import PASSWORD, USERNAME, MockSiteVisitPortal  # noqa: E402

from tegg import canonical, evidence, sitevisit  # noqa: E402
from tegg.browser import launch  # noqa: E402
from tegg.sitevisit import ExplorationError, Explorer  # noqa: E402

SETTINGS = {
    "login_path": "/auth/login",
    "login_labels": {"username": "User Id", "password": "Password", "submit": "Log In"},
    "documentation_labels": ["Documentation"],
    "document_library_labels": ["Document Library"],
    "certificate_labels": ["Certificates"],
    "download_timeout_ms": 8000,
}


@pytest.fixture
def portal():
    with MockSiteVisitPortal() as server:
        yield server


@pytest.fixture
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        instance = launch(playwright, headless=True)
        yield instance
        instance.close()


@pytest.fixture
def explorer(portal, browser, tmp_path):
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    recorder = evidence.Recorder(tmp_path / "evidence")
    yield Explorer(page, portal.url, recorder, SETTINGS)
    context.close()


@pytest.fixture
def signed_in(explorer):
    explorer.login(USERNAME, PASSWORD, None)
    return explorer


class TestLogin:
    def test_signs_in(self, signed_in):
        assert "gm-dashboard" in signed_in.page.url
        assert signed_in.recorder.by_outcome(evidence.AVAILABLE)

    def test_bad_credentials_fail_closed_with_evidence(self, explorer):
        with pytest.raises(ExplorationError) as caught:
            explorer.login(USERNAME, "wrong-password", None)
        assert caught.value.outcome == evidence.PERMISSION
        assert explorer.recorder.by_outcome(evidence.PERMISSION)
        assert list((explorer.recorder.directory).glob("*.html"))

    def test_credentials_never_reach_the_evidence_files(self, explorer, tmp_path):
        with pytest.raises(ExplorationError):
            explorer.login(USERNAME, "hunter2-secret", None)
        for path in explorer.recorder.directory.rglob("*"):
            if path.is_file():
                assert b"hunter2-secret" not in path.read_bytes()


class TestListing:
    def test_lists_only_completed_site_visits(self, signed_in):
        signed_in.open_documentation()
        visits = signed_in.list_completed_site_visits()
        identifiers = {v.identifier for v in visits}
        assert "71999" in identifiers
        assert "72104" in identifiers
        assert "72200" not in identifiers  # In Progress

    def test_captures_customer_and_date(self, signed_in):
        signed_in.open_documentation()
        visit = next(
            v for v in signed_in.list_completed_site_visits() if v.identifier == "71999"
        )
        assert "Acme" in visit.customer
        assert visit.date == "05/14/2026"
        assert visit.url.endswith("/site-visit/71999")

    def test_listing_is_recorded_as_evidence(self, signed_in):
        signed_in.open_documentation()
        signed_in.list_completed_site_visits()
        steps = [o.step for o in signed_in.recorder.observations]
        assert "list_site_visits" in steps
        assert (signed_in.recorder.directory / "observations.json").exists()


class TestSiteVisitContext:
    def test_opens_the_chosen_visit(self, signed_in):
        signed_in.open_documentation()
        visit = next(
            v for v in signed_in.list_completed_site_visits() if v.identifier == "71999"
        )
        signed_in.open_site_visit(visit)
        assert "71999" in signed_in.page.url

    def test_refuses_a_page_that_is_not_the_chosen_visit(self, signed_in):
        """Fail closed rather than download against the wrong customer."""
        signed_in.open_documentation()
        bogus = sitevisit.SiteVisit(
            identifier="99999",
            label="Nowhere",
            url=f"{signed_in.base_url}/sales/gm-dashboard",
        )
        with pytest.raises(ExplorationError) as caught:
            signed_in.open_site_visit(bogus)
        assert caught.value.outcome == evidence.WRONG_CONTEXT

    def test_inventories_the_actions_offered(self, signed_in):
        signed_in.open_documentation()
        visit = next(
            v for v in signed_in.list_completed_site_visits() if v.identifier == "71999"
        )
        signed_in.open_site_visit(visit)
        actions = signed_in.inventory_actions()
        assert any("Document Library" in a for a in actions)

    def test_opens_the_document_library(self, signed_in):
        signed_in.open_documentation()
        visit = next(
            v for v in signed_in.list_completed_site_visits() if v.identifier == "71999"
        )
        signed_in.open_site_visit(visit)
        assert signed_in.open_document_library() is True
        assert "documents" in signed_in.page.url


@pytest.fixture
def in_library(signed_in):
    signed_in.open_documentation()
    visit = next(
        v for v in signed_in.list_completed_site_visits() if v.identifier == "71999"
    )
    signed_in.open_site_visit(visit)
    assert signed_in.open_document_library()
    return signed_in


class TestDiscovery:
    def test_recognises_every_required_report(self, in_library):
        found = {d.canonical for d in in_library.discover_documents() if d.canonical}
        for key in canonical.REQUIRED_PORTAL_TYPES:
            assert key in found, f"{key} was not discovered"

    def test_maps_portal_labels_to_canonical_types(self, in_library):
        documents = {d.canonical: d for d in in_library.discover_documents()}
        assert (
            documents[canonical.EQUIPMENT_INVENTORY_SHORT].label
            == "Equipment Inventory and Short Form"
        )
        assert (
            documents[canonical.EDS_ALL_PROBLEMS].label
            == "EDS Component Problem Summary and All Problems"
        )


class TestDownloading:
    def test_downloads_the_legacy_doc_certificate(self, in_library, tmp_path):
        saved = in_library.download("Certificates", tmp_path / "Certificates")
        assert saved.exists()
        assert sitevisit.verify_file_type(saved) == "doc"

    def test_downloads_a_pdf_report(self, in_library, tmp_path):
        saved = in_library.download("Problem Count Summary", tmp_path / "pcs.pdf")
        assert sitevisit.verify_file_type(saved) == "pdf"

    def test_a_missing_control_is_unavailable_not_a_crash(self, in_library, tmp_path):
        with pytest.raises(ExplorationError) as caught:
            in_library.download("Nonexistent Report", tmp_path / "x.pdf")
        assert caught.value.outcome == evidence.UNAVAILABLE

    def test_downloads_never_overwrite_an_existing_file(self, in_library, tmp_path):
        first = in_library.download("Problem Count Summary", tmp_path / "pcs.pdf")
        second = in_library.download("Problem Count Summary", tmp_path / "pcs.pdf")
        assert first != second
        assert first.exists() and second.exists()


class TestOutcomeClassification:
    def test_the_generic_reports_page_reads_as_a_missing_agreement(self, signed_in):
        """The trap: this page looks fine but has no agreements on it."""
        signed_in.page.goto(f"{signed_in.base_url}/reports")
        outcome = evidence.classify_page_text(signed_in.page.inner_text("body"))
        assert outcome == evidence.MISSING_AGREEMENT

    def test_an_expired_session_is_detected_and_fails_closed(self, signed_in, portal):
        signed_in.open_documentation()
        portal.expire()
        signed_in.page.goto(f"{signed_in.base_url}/documentation")
        with pytest.raises(ExplorationError) as caught:
            signed_in.guard_session("list_site_visits")
        assert caught.value.outcome == evidence.SESSION_EXPIRED

    @pytest.mark.parametrize(
        "text,expected",
        [
            ("There are currently no agreements", evidence.MISSING_AGREEMENT),
            ("Access denied", evidence.PERMISSION),
            ("Your session has expired", evidence.SESSION_EXPIRED),
            ("No records found", evidence.UNAVAILABLE),
            ("Everything is fine", None),
        ],
    )
    def test_phrases_map_to_outcomes(self, text, expected):
        assert evidence.classify_page_text(text) == expected


class TestEvidence:
    def test_snapshots_are_written_at_boundaries(self, in_library):
        files = list(in_library.recorder.directory.iterdir())
        assert any(f.suffix == ".png" for f in files)
        assert any(f.suffix == ".html" for f in files)
        assert any(f.suffix == ".json" for f in files)

    def test_inventory_captures_links_and_tables(self, signed_in):
        signed_in.open_documentation()
        data = evidence.inventory(signed_in.page)
        assert data["links"]
        assert data["tables"]
        assert "Acme" in data["visible_text"]

    def test_html_error_pages_are_not_accepted_as_documents(self, tmp_path):
        path = tmp_path / "fake.pdf"
        path.write_bytes(b"<!doctype html><html>error</html>")
        assert sitevisit.verify_file_type(path) == "unknown"
