"""The whole workflow, portal to finished report, against the mock portal.

This is the closest thing to a real run that can exist without the live site:
seven documents pulled through the browser, the certificate edited and
converted, the IR cover split off, and all ten sections merged into the
deliverable in a Company/Site/Year folder.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

pytest.importorskip("playwright")

from mock_portal import PASSWORD, USERNAME, MockPortal, make_pdf  # noqa: E402

from tegg import cli  # noqa: E402
from tegg.assemble import page_count  # noqa: E402
from tegg.config import Job, Workflow  # noqa: E402

WORKFLOW = ROOT / "config" / "workflow.yaml"
JOB = ROOT / "config" / "job.example.yaml"

HAS_SOFFICE = bool(shutil.which("soffice") or shutil.which("libreoffice"))


@pytest.fixture
def assets(tmp_path):
    """The two documents that don't come from the portal."""
    folder = tmp_path / "assets"
    folder.mkdir()
    for name, pages in (
        ("ESA Table of Contents.pdf", 1),
        ("TEGGPro View Customer Instructions.pdf", 2),
    ):
        (folder / name).write_bytes(make_pdf(name, pages))
    return folder


@pytest.fixture
def credentials(monkeypatch):
    monkeypatch.setenv("TEGG_USERNAME", USERNAME)
    monkeypatch.setenv("TEGG_PASSWORD", PASSWORD)


def _args(**overrides):
    base = {
        "workflow": str(WORKFLOW),
        "job": str(JOB),
        "assets": None,
        "drive_root": None,
        "out": None,
        "source": None,
        "base_url": None,
        "headed": False,
        "dry_run": False,
    }
    base.update(overrides)
    return type("Args", (), base)()


@pytest.mark.skipif(not HAS_SOFFICE, reason="LibreOffice not installed")
def test_full_pipeline(tmp_path, assets, credentials):
    downloads = tmp_path / "downloads"
    drive = tmp_path / "drive"

    with MockPortal() as portal:
        args = _args(
            assets=str(assets),
            drive_root=str(drive),
            out=str(downloads),
            base_url=portal.url,
        )
        assert cli.cmd_run(args) == 0

    workflow = Workflow.from_file(WORKFLOW)
    job = Job.from_file(JOB)
    folder = (
        drive
        / workflow.raw["destination"]["root"]
        / job.company
        / job.site
        / job.year
    )

    report = folder / workflow.output_name(job)
    assert report.exists(), f"report not produced in {folder}"

    # 1 cover + 1 toc + 1 cert + 2 pcs + 5 eis + 12 eil + 8 ir-body + 7 eip
    # + 4 eds + 2 instructions
    assert page_count(report) == 43

    manifest = folder / "build-manifest.json"
    assert manifest.exists()

    import json

    payload = json.loads(manifest.read_text())
    assert len(payload["sections"]) == 10
    assert payload["job"]["agreement"] == job.agreement
    assert payload["output"]["pages"] == 43


def test_fetch_downloads_all_seven(tmp_path, credentials):
    downloads = tmp_path / "downloads"
    with MockPortal() as portal:
        args = _args(out=str(downloads), base_url=portal.url)
        assert cli.cmd_fetch(args) == 0

    got = sorted(p.name for p in downloads.iterdir() if p.is_file())
    assert got == [
        "Certificates.docx",
        "EDSAllProblemsOnly.pdf",
        "EquipmentInventoryLongForm.pdf",
        "EquipmentInventoryShortForm.pdf",
        "EquipmentItemProblem_AllImages.pdf",
        "ProblemCountSummary.pdf",
        "StandardIRReport.pdf",
    ]


def test_fetch_reports_failure_and_writes_diagnostics(tmp_path, credentials):
    """A portal that doesn't match must produce diagnostics, not a silent pass."""
    downloads = tmp_path / "downloads"
    with MockPortal() as portal:
        args = _args(out=str(downloads), base_url=portal.url)
        # Point the driver at a page with none of the expected controls.
        args.base_url = portal.url
        import tegg.portal as portal_module

        original = portal_module.PortalSession.navigate

        def broken(self, trail):
            return original(self, ["Documentation"] if trail else trail)

        portal_module.PortalSession.navigate = broken
        try:
            result = cli.cmd_fetch(args)
        finally:
            portal_module.PortalSession.navigate = original

    assert result == 1
    diagnostics = list((downloads / "diagnostics").glob("diagnostic-*.json"))
    assert diagnostics, "expected diagnostic dumps for the failed documents"
