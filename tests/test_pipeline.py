"""Assembly: order, completeness, and the checks that stop a bad report.

Every test here corresponds to a way a real ESA report can go wrong -- a
section missing, a section duplicated, pages silently lost in the merge, or a
draft going out without being marked as one.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from mock_portal import make_pdf  # noqa: E402

from tegg import canonical, draft, pipeline  # noqa: E402
from tegg import workspace as ws  # noqa: E402
from tegg.assemble import page_count  # noqa: E402

# Page counts chosen so the total is unambiguous.
PORTAL_PAGES = {
    canonical.PROBLEM_COUNT_SUMMARY: 2,
    canonical.EQUIPMENT_INVENTORY_SHORT: 5,
    canonical.EQUIPMENT_INVENTORY_LONG: 12,
    canonical.STANDARD_IR: 9,
    canonical.EQUIPMENT_ITEM_PROBLEMS: 7,
    canonical.EDS_ALL_PROBLEMS: 4,
}


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
def seeded(tmp_path, assets):
    """A workspace holding every portal PDF, plus a certificate PDF already
    converted. The certificate is stubbed as a PDF so these tests do not need
    LibreOffice."""
    workspace = ws.Workspace.create(
        tmp_path / "work", "job-1", customer="Acme", site="Plant 3"
    )
    for key, pages in PORTAL_PAGES.items():
        name = canonical.output_filename(key)
        path = workspace.source / name
        path.write_bytes(make_pdf(name, pages))
        workspace.mark_downloaded(key, path, discovered_name=name)

    certificate = workspace.converted / "Certificates good.pdf"
    certificate.write_bytes(make_pdf("Certificates good", 2))
    record = workspace.record(canonical.CERTIFICATE)
    record.status = ws.CONVERTED
    record.converted_path = workspace.relative(certificate)
    record.conversion_status = "converted"
    workspace.put(record)

    pipeline.stage_static_assets(workspace, assets)
    pipeline.derive_ir_sections(workspace)
    return workspace


class TestStaging:
    def test_static_assets_are_copied_not_moved(self, tmp_path, assets):
        workspace = ws.Workspace.create(tmp_path / "work", "job-static")
        assert pipeline.stage_static_assets(workspace, assets) == []
        assert (assets / canonical.output_filename(canonical.TABLE_OF_CONTENTS)).exists()
        assert (
            workspace.converted / canonical.output_filename(canonical.TABLE_OF_CONTENTS)
        ).exists()

    def test_missing_static_assets_are_reported(self, tmp_path):
        workspace = ws.Workspace.create(tmp_path / "work", "job-static-2")
        missing = pipeline.stage_static_assets(workspace, tmp_path / "nothing")
        assert len(missing) == 2

    def test_ir_split_produces_cover_and_body(self, seeded):
        cover = seeded.record(canonical.COVER)
        body = seeded.record(canonical.STANDARD_IR_NO_COVER)
        assert page_count(seeded.resolve(cover.local_path)) == 1
        assert page_count(seeded.resolve(body.local_path)) == 8

    def test_ir_split_does_not_modify_the_source(self, seeded):
        source = seeded.resolve(seeded.record(canonical.STANDARD_IR).local_path)
        assert page_count(source) == 9


class TestCollect:
    def test_returns_all_ten_sections_in_business_order(self, seeded):
        components, missing = pipeline.collect(seeded)
        assert missing == []
        assert [c.key for c in components] == canonical.BUSINESS_ORDER

    def test_reports_every_missing_section_at_once(self, tmp_path, assets):
        workspace = ws.Workspace.create(tmp_path / "work", "empty")
        pipeline.stage_static_assets(workspace, assets)
        components, missing = pipeline.collect(workspace)
        assert len(missing) == 8  # ten sections less the two static ones
        assert len(components) == 2

    def test_a_recorded_but_deleted_file_is_missing_not_silently_dropped(self, seeded):
        record = seeded.record(canonical.EDS_ALL_PROBLEMS)
        seeded.resolve(record.local_path).unlink()
        _, missing = pipeline.collect(seeded)
        assert any("EDS" in m for m in missing)

    def test_a_non_pdf_is_refused(self, seeded):
        record = seeded.record(canonical.EDS_ALL_PROBLEMS)
        bad = seeded.source / "EDSAllProblemsOnly.doc"
        bad.write_bytes(b"\xd0\xcf\x11\xe0not a pdf")
        record.local_path = seeded.relative(bad)
        seeded.put(record)
        _, missing = pipeline.collect(seeded)
        assert any("not a PDF" in m for m in missing)

    def test_the_same_file_is_never_inserted_twice(self, seeded):
        """Two sections pointing at one file would duplicate pages."""
        duplicate = seeded.record(canonical.EDS_ALL_PROBLEMS)
        duplicate.local_path = seeded.record(canonical.PROBLEM_COUNT_SUMMARY).local_path
        seeded.put(duplicate)
        with pytest.raises(pipeline.PipelineError, match="same file twice"):
            pipeline.collect(seeded)


class TestBuild:
    def test_builds_a_draft_with_the_expected_page_count(self, seeded):
        result = pipeline.build(seeded, "Acme Plant 3 2026 ESA Report.pdf")
        assert result.ok
        # 1 cover + 1 toc + 2 cert + 2 pcs + 5 short + 12 long + 8 body
        # + 7 items + 4 eds + 2 instructions
        assert result.pages == 44
        assert page_count(result.output) == 44

    def test_the_final_page_count_equals_the_sum_of_its_parts(self, seeded):
        result = pipeline.build(seeded, "report.pdf")
        assert result.pages == sum(c.pages for c in result.components)

    def test_output_lands_only_in_the_output_folder(self, seeded):
        result = pipeline.build(seeded, "report.pdf")
        assert result.output.parent == seeded.output

    def test_drafts_are_named_and_marked(self, seeded):
        result = pipeline.build(seeded, "report.pdf")
        assert result.output.name.startswith(draft.FILENAME_PREFIX)
        assert result.review_required

    def test_final_mode_drops_the_draft_prefix(self, seeded):
        result = pipeline.build(seeded, "report.pdf", mark_draft=False)
        assert result.output.name == "report.pdf"

    def test_no_intermediate_merge_file_is_left_behind(self, seeded):
        pipeline.build(seeded, "report.pdf")
        assert not list(seeded.output.glob(".merge-*"))

    def test_a_blocked_build_writes_nothing(self, tmp_path, assets):
        workspace = ws.Workspace.create(tmp_path / "work", "blocked")
        pipeline.stage_static_assets(workspace, assets)
        result = pipeline.build(workspace, "report.pdf")
        assert not result.ok
        assert result.output is None
        assert list(workspace.output.iterdir()) == []
        assert workspace.data["build"]["status"] == "blocked"

    def test_the_manifest_records_the_exact_merge_order(self, seeded):
        pipeline.build(seeded, "report.pdf")
        order = [s["canonical_type"] for s in seeded.data["build"]["merge_order"]]
        assert order == canonical.BUSINESS_ORDER

    def test_the_manifest_records_checksums_and_pages(self, seeded):
        pipeline.build(seeded, "report.pdf")
        for section in seeded.data["build"]["merge_order"]:
            assert section["checksum"]
            assert section["pages"] > 0

    def test_building_twice_is_stable(self, seeded):
        first = pipeline.build(seeded, "report.pdf")
        second = pipeline.build(seeded, "report.pdf")
        assert first.pages == second.pages
        assert second.ok


class TestDraftMarking:
    def test_watermark_preserves_the_page_count(self, tmp_path):
        source = tmp_path / "in.pdf"
        source.write_bytes(make_pdf("body", 3))
        output, _ = draft.apply(source, tmp_path / "out.pdf")
        assert page_count(output) == 3

    def test_watermark_does_not_touch_the_source(self, tmp_path):
        source = tmp_path / "in.pdf"
        source.write_bytes(make_pdf("body", 3))
        before = source.read_bytes()
        draft.apply(source, tmp_path / "out.pdf")
        assert source.read_bytes() == before

    def test_filename_prefix_is_idempotent(self):
        once = draft.draft_filename("report.pdf")
        assert draft.draft_filename(once) == once
