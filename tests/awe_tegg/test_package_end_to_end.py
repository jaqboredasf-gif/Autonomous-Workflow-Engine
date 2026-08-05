"""The whole package, produced through the real click-path, in a real browser.

Everything else about the contract is asserted against hand-built files. This
drives the actual production code -- :class:`documents.ReportRun`, the same
class that runs against the live portal -- through a mock reproducing the
portal's typeahead, its expand-only parents, its late SSRS toolbar, its inline
PDF response, and its *separate* Document Library route for the certificate.

This is the test that would have failed before the change: the operation asked
for two reports, so two arrived, and the run said it was finished.

The mock's report list carries decoys on purpose. The live Standard ESA
Reports list offers four reports whose name ends in "Summary" -- Problem Count,
Inventory, Visual Inspection, Tasking Completion -- plus the EDS Component
Problem Summary the package actually wants. A route that matched on the word
"Summary" would fetch the wrong document here, rather than passing against a
mock that only offered the right answer.

Marked ``slow``: it starts a browser and renders six reports.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from awe_tegg import deliverables, documents, email_draft, intake, visit_operation
from mock_ssrs import AGREEMENT, MockSSRSPortal

playwright_api = pytest.importorskip("playwright.sync_api")

#: The six that come from Reports > Standard ESA Reports.
ESA_REPORTS = [
    item for item in deliverables.REQUIRED
    if item.source == deliverables.FROM_ESA_REPORT
]


@pytest.fixture
def portal():
    with MockSSRSPortal() as server:
        yield server


@pytest.fixture
def page(portal):
    with playwright_api.sync_playwright() as driver:
        browser = driver.chromium.launch()
        context = browser.new_context(accept_downloads=True)
        sheet = context.new_page()
        sheet.goto(portal.documentation_url, wait_until="domcontentloaded")
        yield sheet
        context.close()
        browser.close()


class Ledger:
    """Enough RunLedger for the retrieval path, and nothing more."""

    def __init__(self) -> None:
        self.data: dict = {"steps": []}
        self.notes: list[str] = []
        self.escalations: list[str] = []

    def note(self, message: str) -> None:
        self.notes.append(message)

    def escalate(self, message: str) -> None:
        self.escalations.append(message)


VISIT = {"identifier": "T25-204", "agreement": AGREEMENT,
         "site": "The Factory", "customer": "Atlas Capital"}


def _run(page, out_dir: Path) -> documents.ReportRun:
    return documents.ReportRun(
        page,
        out_dir=out_dir,
        budget=documents.RetrievalBudget(max_actions=200, max_seconds=900),
        settle_ms=400,
        viewer_timeout_ms=30_000,
        export_timeout_ms=60_000,
    )


def _at_reports(page, tmp_path: Path) -> documents.ReportRun:
    reports = _run(page, tmp_path)
    reports.select_site("The Factory", customer="Atlas Capital")
    reports.open_report_list()
    return reports


def _assets(tmp_path: Path) -> Path:
    """A stand-in for ``assets/static`` holding a real Table of Contents."""
    from pypdf import PdfWriter

    directory = tmp_path / "assets"
    directory.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    for _ in range(2):
        writer.add_blank_page(width=612, height=792)
    with (directory / "ESA Table of Contents.pdf").open("wb") as handle:
        writer.write(handle)
    return directory


def test_the_site_is_selected_over_the_customer(page, portal, tmp_path):
    """Landing on the customer produces empty reports that still 'succeed'."""
    reports = _run(page, tmp_path)
    chosen = reports.select_site("The Factory", customer="Atlas Capital")
    assert "Factory" in chosen


# ---------------------------------------------------------------------------
# The six Standard ESA Reports
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_all_six_esa_reports_are_produced(page, portal, tmp_path):
    reports = _at_reports(page, tmp_path)

    ledger = Ledger()
    manifest = deliverables.Manifest.create("T25-204")
    retrieved = visit_operation._retrieve(reports, VISIT, ledger, manifest)

    assert len(retrieved) == len(ESA_REPORTS), (
        f"expected {len(ESA_REPORTS)} reports, got {sorted(retrieved)}"
    )
    for expected in ESA_REPORTS:
        entry = manifest.entry(expected.key)
        path = Path(entry.location)
        assert path.exists(), f"{expected.canonical_name} is not on disk"
        assert path.read_bytes()[:5] == b"%PDF-"
        assert entry.validation == deliverables.VALID
        assert entry.status == deliverables.GENERATED
        assert entry.page_count and entry.page_count > 0

    # Six distinct files, not one file filed six times.
    assert len({e.generated_filename for e in manifest.entries if e.ok}) == 6
    assert len({e.sha256 for e in manifest.entries if e.ok}) == 6
    assert not manifest.duplicates()
    assert not portal.mutations, "the retrieval posted something"


@pytest.mark.slow
def test_the_long_and_short_inventory_come_back_as_different_documents(
    page, portal, tmp_path
):
    """The requirement that neither may satisfy the other, proved on real files."""
    reports = _at_reports(page, tmp_path)
    ledger = Ledger()
    manifest = deliverables.Manifest.create("T25-204")
    visit_operation._retrieve(reports, VISIT, ledger, manifest)

    long_form = manifest.entry("equipment_inventory_long")
    short_form = manifest.entry("equipment_inventory_short")

    assert long_form.ok and short_form.ok
    assert long_form.location != short_form.location
    assert long_form.generated_filename != short_form.generated_filename
    assert long_form.sha256 != short_form.sha256
    # Different reports, so different lengths. Same page count would mean the
    # same render came back twice under two names.
    assert long_form.page_count != short_form.page_count
    assert Path(long_form.location).read_bytes() != \
        Path(short_form.location).read_bytes()


@pytest.mark.slow
def test_the_summary_slot_gets_eds_and_not_a_similarly_named_report(
    page, portal, tmp_path
):
    """Four reports on this list end in 'Summary'. Only one is the right one."""
    reports = _at_reports(page, tmp_path)
    ledger = Ledger()
    manifest = deliverables.Manifest.create("T25-204")
    visit_operation._retrieve(reports, VISIT, ledger, manifest)

    summary = manifest.entry("eds_all_problems")
    counts = manifest.entry("problem_count_summary")
    assert summary.ok and counts.ok
    assert summary.sha256 != counts.sha256
    # The EDS report is nested under an All Problems child; the decoys are not.
    assert summary.route == "EDS Component Problem Summary > All Problems"
    assert counts.route == "Problem Count Summary"


@pytest.mark.slow
def test_the_expand_only_parent_is_walked_to_its_child(page, portal, tmp_path):
    """'Equipment Inventory' is not a report; 'Short Form' under it is."""
    reports = _at_reports(page, tmp_path)
    got = reports.retrieve(
        "Inventory Equipment - Short Form",
        ("Equipment Inventory", "Short Form"),
        agreement=AGREEMENT,
        filename="short.pdf",
    )
    assert Path(got.path).read_bytes()[:5] == b"%PDF-"
    assert any("Agreement=" in p for p in got.parameters)


# ---------------------------------------------------------------------------
# The Table of Contents and the Certificate: the other two sources
# ---------------------------------------------------------------------------


def test_the_table_of_contents_is_copied_from_the_shipped_assets(tmp_path):
    """It is a static file. It is not fetched from TEGG and never has been."""
    manifest = deliverables.Manifest.create("T25-204")
    entry = visit_operation.stage_table_of_contents(
        manifest, tmp_path / "documents", assets_dir=_assets(tmp_path)
    )
    assert entry.ok
    assert entry.status == deliverables.COPIED
    assert entry.source == deliverables.FROM_STATIC
    assert Path(entry.location).exists()
    assert entry.page_count == 2


def test_a_missing_table_of_contents_fails_the_slot_rather_than_the_run(tmp_path):
    manifest = deliverables.Manifest.create("T25-204")
    entry = visit_operation.stage_table_of_contents(
        manifest, tmp_path / "documents", assets_dir=tmp_path / "empty"
    )
    assert not entry.ok
    assert entry.status == deliverables.FAILED
    assert "ships with the tool" in entry.detail


@pytest.mark.slow
def test_the_certificate_comes_from_the_document_library_route(
    page, portal, tmp_path
):
    """A different tab, a Solution parameter, and a legacy .doc to convert."""
    from tegg.certificate import find_soffice

    reports = _run(page, tmp_path)
    reports.select_site("The Factory", customer="Atlas Capital")

    manifest = deliverables.Manifest.create("T25-204")
    entry = visit_operation.retrieve_certificate(
        reports, VISIT, manifest, tmp_path / "converted"
    )

    assert "/certificate-file" in portal.seen, (
        "the certificate was not fetched through the Document Library route"
    )
    assert not portal.mutations

    if find_soffice():
        assert entry.ok, f"conversion failed: {entry.detail}"
        assert entry.status == deliverables.CONVERTED
        assert Path(entry.location).suffix == ".pdf"
        assert Path(entry.location).read_bytes()[:5] == b"%PDF-"
    else:
        # No LibreOffice on this machine. The failure must say so plainly
        # rather than reporting a document that is not there.
        assert not entry.ok
        assert "LibreOffice" in entry.detail


@pytest.mark.slow
def test_a_refused_certificate_is_reported_and_does_not_stop_the_reports(
    page, portal, tmp_path
):
    portal.refuse("certificate")
    reports = _run(page, tmp_path)
    reports.select_site("The Factory", customer="Atlas Capital")

    manifest = deliverables.Manifest.create("T25-204")
    entry = visit_operation.retrieve_certificate(
        reports, VISIT, manifest, tmp_path / "converted"
    )
    assert not entry.ok
    assert entry.status == deliverables.FAILED

    # The six reports still come back, so the operator learns about all of it.
    reports.open_report_list()
    visit_operation._retrieve(reports, VISIT, Ledger(), manifest)
    assert len(manifest.produced) == 6


# ---------------------------------------------------------------------------
# The whole package
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_the_full_eight_document_package_reaches_a_draft(page, portal, tmp_path):
    """Every source -> manifest -> email draft, on genuinely produced files."""
    from tegg.certificate import find_soffice

    if not find_soffice():
        pytest.skip("no LibreOffice, so the certificate cannot be converted here")

    reports = _run(page, tmp_path)
    reports.select_site("The Factory", customer="Atlas Capital")

    manifest = deliverables.Manifest.create("T25-204")
    visit_operation.stage_table_of_contents(
        manifest, tmp_path / "documents", assets_dir=_assets(tmp_path)
    )
    visit_operation.retrieve_certificate(
        reports, VISIT, manifest, tmp_path / "converted"
    )
    reports.open_report_list()
    visit_operation._retrieve(reports, VISIT, Ledger(), manifest)

    assert manifest.complete, manifest.render()
    assert len(manifest.produced) == deliverables.REQUIRED_COUNT == 8
    manifest.enforce()

    answers = intake.Intake(
        site_visit="T25-204", customer="Atlas Capital", site="The Factory",
        site_address="120 Mill Street", recipient_name="Paul Lippolis",
        recipient_email="paul@example.com", job_number="T25-204-ESA",
    )
    draft = email_draft.write(
        email_draft.build(answers, manifest), tmp_path / "email"
    )

    assert draft.attached_ok
    assert len(draft.attachments) == 8
    assert len(draft.staged) == 8
    for name in manifest.filenames():
        assert name in draft.body, f"{name} is not named in the email"

    raw = draft.path.read_bytes()
    assert raw.count(b"Content-Type: application/pdf") == 8
    assert b"paul@example.com" in raw
    assert draft.to_dict()["sent"] is False

    # The progress display an operator sees, counting to eight.
    shown = manifest.render()
    assert "[1/8]" in shown and "[8/8]" in shown
    assert "8 of 8 required documents produced." in shown


@pytest.mark.slow
def test_a_refused_report_produces_a_short_package_and_a_failed_run(
    page, portal, tmp_path
):
    """Seven of eight must be a failure, with the missing one named."""
    portal.refuse("eil")                      # Equipment Inventory Long Form
    reports = _run(page, tmp_path)
    reports.select_site("The Factory", customer="Atlas Capital")

    manifest = deliverables.Manifest.create("T25-204")
    visit_operation.stage_table_of_contents(
        manifest, tmp_path / "documents", assets_dir=_assets(tmp_path)
    )
    visit_operation.retrieve_certificate(
        reports, VISIT, manifest, tmp_path / "converted"
    )
    reports.open_report_list()
    visit_operation._retrieve(reports, VISIT, Ledger(), manifest)

    assert not manifest.complete
    with pytest.raises(deliverables.DeliverableError) as stop:
        manifest.enforce()
    message = str(stop.value)
    assert "Inventory Equipment - Long Form" in message
    assert "Not calling this finished" in message

    # And nothing may be emailed about a short package.
    answers = intake.Intake(recipient_email="paul@example.com")
    with pytest.raises(deliverables.DeliverableError):
        email_draft.build(answers, manifest)


@pytest.mark.slow
def test_a_rerun_against_the_same_folder_renders_nothing_again(
    page, portal, tmp_path
):
    from awe_tegg import findings as findings_module

    reports = _at_reports(page, tmp_path)

    ledger = Ledger()
    manifest = deliverables.Manifest.create("T25-204")
    first = visit_operation._retrieve(reports, VISIT, ledger, manifest)
    for record in first.values():
        record["sha256"] = findings_module.checksum(Path(record["path"]))

    before = len([p for p in portal.seen if p == "/export"])
    assert before == len(ESA_REPORTS)

    second = deliverables.Manifest.create("T25-204")
    visit_operation._retrieve(reports, VISIT, ledger, second, already=first)

    after = len([p for p in portal.seen if p == "/export"])
    assert after == before, "a rerun asked the portal to render again"
    assert all(second.entry(e.key).status == deliverables.REUSED
               for e in ESA_REPORTS)
