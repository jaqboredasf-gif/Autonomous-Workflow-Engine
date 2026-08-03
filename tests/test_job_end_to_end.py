"""The whole site-visit workflow, portal to draft report.

This is the vertical slice the tool exists for: sign in, pick one completed
site visit, pull the certificate and the six reports, convert the legacy .doc,
split the IR cover, and assemble ten sections in the business order -- ending
with a DRAFT marked for human review.

The certificate served here is a genuine LibreOffice-produced legacy .doc, so
the conversion path is exercised for real rather than stubbed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

pytest.importorskip("playwright")

from mock_portal import make_pdf  # noqa: E402
from mock_sitevisit import PASSWORD, USERNAME, MockSiteVisitPortal  # noqa: E402

from tegg import canonical, certdoc, cli  # noqa: E402
from tegg import workspace as ws  # noqa: E402
from tegg.assemble import page_count  # noqa: E402
from tegg.certificate import find_soffice  # noqa: E402

WORKFLOW = ROOT / "config" / "workflow.yaml"
HAS_SOFFICE = bool(find_soffice())

pytestmark = pytest.mark.skipif(
    not HAS_SOFFICE, reason="LibreOffice not installed"
)


@pytest.fixture(scope="module")
def legacy_doc(tmp_path_factory):
    """A real legacy .doc, the format the portal actually serves."""
    from test_certdoc import _wingdings_certificate

    folder = tmp_path_factory.mktemp("cert")
    docx = _wingdings_certificate(folder / "Certificates71999.docx")
    return certdoc.convert(docx, folder, target="doc").read_bytes()


@pytest.fixture
def assets(tmp_path):
    folder = tmp_path / "assets"
    folder.mkdir()
    for key, pages in (
        (canonical.TABLE_OF_CONTENTS, 1),
        (canonical.CUSTOMER_INSTRUCTIONS, 2),
    ):
        name = canonical.output_filename(key)
        (folder / name).write_bytes(make_pdf(name, pages))
    return folder


@pytest.fixture
def credentials(monkeypatch):
    monkeypatch.setenv("TEGG_USERNAME", USERNAME)
    monkeypatch.setenv("TEGG_PASSWORD", PASSWORD)


def _run(portal, tmp_path, assets, *extra):
    return cli.main(
        [
            "--workflow", str(WORKFLOW),
            "--assets", str(assets),
            "run",
            "--site-visit", "71999",
            "--job-id", "test-71999",
            "--work-root", str(tmp_path / "work"),
            "--base-url", portal.url,
            *extra,
        ]
    )


class TestFullRun:
    @pytest.fixture
    def completed(self, tmp_path, assets, credentials, legacy_doc):
        with MockSiteVisitPortal(certificate_bytes=legacy_doc) as portal:
            code = _run(portal, tmp_path, assets)
        workspace = ws.Workspace.find(tmp_path / "work", "test-71999")
        return code, workspace

    def test_the_run_succeeds(self, completed):
        code, _ = completed
        assert code == 0

    def test_every_portal_document_was_downloaded(self, completed):
        _, workspace = completed
        for key in canonical.REQUIRED_PORTAL_TYPES:
            record = workspace.record(key)
            assert record.status in ws.SETTLED, f"{key} is {record.status}"

    def test_the_certificate_arrived_as_a_legacy_doc_and_was_converted(self, completed):
        _, workspace = completed
        record = workspace.record(canonical.CERTIFICATE)
        assert record.source_filename.endswith(".doc")
        assert record.conversion_status == "converted"
        assert workspace.resolve(record.converted_path).exists()

    def test_the_original_certificate_is_preserved(self, completed):
        _, workspace = completed
        original = workspace.resolve(workspace.record(canonical.CERTIFICATE).local_path)
        assert original.exists()
        assert original.read_bytes()[:4] == b"\xd0\xcf\x11\xe0"

    def test_a_draft_report_was_produced(self, completed):
        _, workspace = completed
        build = workspace.data["build"]
        assert build["status"] == "built"
        assert build["draft"] is True
        assert build["output"].startswith("DRAFT - ")
        assert (workspace.output / build["output"]).exists()

    def test_the_merge_order_is_the_business_order(self, completed):
        _, workspace = completed
        order = [s["canonical_type"] for s in workspace.data["build"]["merge_order"]]
        assert order == canonical.BUSINESS_ORDER

    def test_page_count_equals_the_sum_of_the_sections(self, completed):
        _, workspace = completed
        build = workspace.data["build"]
        report = workspace.output / build["output"]
        assert page_count(report) == build["pages"]
        assert build["pages"] == sum(s["pages"] for s in build["merge_order"])

    def test_the_job_is_flagged_for_human_review(self, completed):
        _, workspace = completed
        assert workspace.data["review_required"] is True
        assert any(
            "by hand" in reason for reason in workspace.data["review_reasons"]
        )

    def test_the_manifest_is_valid_and_complete(self, completed):
        _, workspace = completed
        data = json.loads(workspace.manifest_path.read_text())
        assert data["site_visit"]["identifier"] == "71999"
        for key in canonical.BUSINESS_ORDER:
            assert key in data["documents"]

    def test_evidence_was_captured(self, completed):
        _, workspace = completed
        assert (workspace.evidence / "observations.json").exists()
        assert list(workspace.evidence.glob("*.png"))


class TestResume:
    def test_resume_does_not_download_again(
        self, tmp_path, assets, credentials, legacy_doc
    ):
        with MockSiteVisitPortal(certificate_bytes=legacy_doc) as portal:
            assert _run(portal, tmp_path, assets) == 0
            workspace = ws.Workspace.find(tmp_path / "work", "test-71999")
            before = {
                key: workspace.record(key).downloaded_at
                for key in canonical.REQUIRED_PORTAL_TYPES
            }

            code = cli.main(
                [
                    "--workflow", str(WORKFLOW),
                    "--assets", str(assets),
                    "resume",
                    "--job-id", "test-71999",
                    "--work-root", str(tmp_path / "work"),
                    "--base-url", portal.url,
                ]
            )

        assert code == 0
        workspace = ws.Workspace.find(tmp_path / "work", "test-71999")
        after = {
            key: workspace.record(key).downloaded_at
            for key in canonical.REQUIRED_PORTAL_TYPES
        }
        assert before == after, "resume re-downloaded documents it already had"

    def test_resume_with_nothing_outstanding_skips_the_browser(
        self, tmp_path, assets, credentials, legacy_doc
    ):
        """Once everything is present, no portal is needed at all."""
        with MockSiteVisitPortal(certificate_bytes=legacy_doc) as portal:
            assert _run(portal, tmp_path, assets) == 0

        # The portal is now shut down; a resume must still succeed.
        code = cli.main(
            [
                "--workflow", str(WORKFLOW),
                "--assets", str(assets),
                "resume",
                "--job-id", "test-71999",
                "--work-root", str(tmp_path / "work"),
            ]
        )
        assert code == 0


class TestSafety:
    def test_an_unknown_site_visit_fails_without_building(
        self, tmp_path, assets, credentials, legacy_doc
    ):
        with MockSiteVisitPortal(certificate_bytes=legacy_doc) as portal:
            code = cli.main(
                [
                    "--workflow", str(WORKFLOW),
                    "--assets", str(assets),
                    "run",
                    "--site-visit", "00000",
                    "--job-id", "bad-visit",
                    "--work-root", str(tmp_path / "work"),
                    "--base-url", portal.url,
                ]
            )
        assert code == 2
        workspace = ws.Workspace.find(tmp_path / "work", "bad-visit")
        assert not list(workspace.output.iterdir())

    def test_missing_static_assets_block_the_build(
        self, tmp_path, credentials, legacy_doc
    ):
        empty = tmp_path / "no-assets"
        empty.mkdir()
        with MockSiteVisitPortal(certificate_bytes=legacy_doc) as portal:
            code = _run(portal, tmp_path, empty)
        assert code == 1
        workspace = ws.Workspace.find(tmp_path / "work", "test-71999")
        assert workspace.data["build"]["status"] == "blocked"
        assert not list(workspace.output.iterdir())
