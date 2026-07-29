"""End-to-end driver tests against the mock portal.

These exercise the real driver code -- login, navigation, dropdown handling,
the print/export flow and downloads -- against a local server that reproduces
the structure Paul's SOP describes. What they cannot verify is whether the live
TEGG Pro site words its labels the same way; that is the one remaining unknown,
and `capture_diagnostics` exists to answer it on the first real run.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

pytest.importorskip("playwright")

from mock_portal import PASSWORD, USERNAME, MockPortal  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

from tegg.assemble import page_count  # noqa: E402
from tegg.browser import launch  # noqa: E402
from tegg.config import Job, Workflow  # noqa: E402
from tegg.portal import (  # noqa: E402
    PortalError,
    PortalSession,
    capture_diagnostics,
    find_button,
    select_value,
)

WORKFLOW = ROOT / "config" / "workflow.yaml"
JOB = ROOT / "config" / "job.example.yaml"


@pytest.fixture(scope="module")
def portal():
    with MockPortal() as server:
        yield server


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as playwright:
        instance = launch(playwright, headless=True)
        yield instance
        instance.close()


@pytest.fixture
def page(browser):
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    yield page
    context.close()


@pytest.fixture
def workflow():
    return Workflow.from_file(WORKFLOW)


@pytest.fixture
def job():
    return Job.from_file(JOB)


@pytest.fixture
def session(page, portal, workflow, tmp_path):
    return PortalSession(page, portal.url, workflow, tmp_path / "diag")


class TestLogin:
    def test_successful_login(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        assert "gm-dashboard" in session.page.url

    def test_bad_password_raises_and_dumps_diagnostics(self, session, tmp_path):
        with pytest.raises(PortalError, match="login did not complete"):
            session.login(USERNAME, "wrong", "Lippolis")
        assert (tmp_path / "diag" / "diagnostic-login-failed.json").exists()

    def test_login_works_on_a_site_without_a_contractor_picker(
        self, page, workflow, tmp_path
    ):
        """The contractor step must be optional, not assumed."""
        with MockPortal(require_contractor=False) as plain:
            session = PortalSession(page, plain.url, workflow, tmp_path / "diag")
            session.login(USERNAME, PASSWORD, "Lippolis")
            assert "gm-dashboard" in session.page.url


class TestNavigation:
    def test_follows_a_breadcrumb(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        session.navigate(["Reports", "Standard ESA Reports", "Problem Count Summary"])
        assert "Problem Count Summary" in session.page.title()

    def test_unknown_link_raises(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        with pytest.raises(PortalError, match="could not find a link"):
            session.navigate(["Nonexistent Section"])


class TestDropdowns:
    def test_selects_by_visible_label(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        session.navigate(["Reports", "Standard ESA Reports", "Problem Count Summary"])
        assert select_value(session.page, "Agreement", "AG-118422") == "AG-118422"

    def test_first_available_sentinel_picks_the_first_option(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        session.navigate(["Reports", "Standard ESA Reports", "Problem Count Summary"])
        chosen = select_value(session.page, "Contact", "__first_available__")
        assert chosen == "Dana Reyes"

    def test_unknown_option_reports_what_was_available(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        session.navigate(["Reports", "Standard ESA Reports", "Problem Count Summary"])
        with pytest.raises(PortalError, match="available:"):
            select_value(session.page, "Agreement", "AG-DOES-NOT-EXIST")

    def test_unknown_field_raises(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        with pytest.raises(PortalError, match="could not find a control"):
            select_value(session.page, "Nonexistent Field", "x")


class TestDownloads:
    def test_downloads_a_report_through_print_and_export(
        self, session, workflow, job, tmp_path
    ):
        session.login(USERNAME, PASSWORD, "Lippolis")
        document = next(
            d for d in workflow.documents if d["key"] == "problem_count_summary"
        )
        result = session.download(document, job, tmp_path)
        assert result.ok, result.error
        assert result.path.name == "ProblemCountSummary.pdf"
        assert page_count(result.path) == 2

    def test_downloads_the_certificate_docx(self, session, workflow, job, tmp_path):
        session.login(USERNAME, PASSWORD, "Lippolis")
        document = next(d for d in workflow.documents if d["key"] == "certificate")
        result = session.download(document, job, tmp_path)
        assert result.ok, result.error
        assert result.path.exists()
        assert result.path.stat().st_size > 0

    def test_report_with_different_params_still_works(
        self, session, workflow, job, tmp_path
    ):
        """The Long Form takes Record Selection instead of Site Visit."""
        session.login(USERNAME, PASSWORD, "Lippolis")
        document = next(
            d for d in workflow.documents if d["key"] == "equipment_inventory_long"
        )
        result = session.download(document, job, tmp_path)
        assert result.ok, result.error
        assert page_count(result.path) == 12

    def test_all_seven_documents(self, session, workflow, job, tmp_path):
        """The full SOP stage 3 + 4 pull."""
        session.login(USERNAME, PASSWORD, "Lippolis")
        results = [session.download(d, job, tmp_path) for d in workflow.documents]

        failed = [f"{r.filename}: {r.error}" for r in results if not r.ok]
        assert not failed, "failed downloads:\n" + "\n".join(failed)
        assert len(results) == 7

        # The IR report must have enough pages to split a cover off.
        ir = tmp_path / "StandardIRReport.pdf"
        assert page_count(ir) == 9


class TestDiagnostics:
    def test_dump_lists_controls_and_writes_artifacts(self, session, tmp_path):
        session.login(USERNAME, PASSWORD, "Lippolis")
        session.navigate(["Reports", "Standard ESA Reports", "Standard IR Report"])
        path = capture_diagnostics(session.page, tmp_path / "d", "probe")

        import json

        info = json.loads(path.read_text())
        labels = [s["label"] for s in info["selects"]]
        assert "Agreement" in labels
        assert "Site Visit" in labels
        assert "Print Report" in info["buttons"]
        assert (tmp_path / "d" / "diagnostic-probe.png").exists()
        assert (tmp_path / "d" / "diagnostic-probe.html").exists()


class TestButtonLookup:
    def test_finds_a_submit_button_by_text(self, session):
        session.login(USERNAME, PASSWORD, "Lippolis")
        session.navigate(["Reports", "Standard ESA Reports", "Problem Count Summary"])
        assert find_button(session.page, "Print Report") is not None
