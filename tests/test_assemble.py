import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from make_fixtures import make_pdf  # noqa: E402
from tegg.assemble import (  # noqa: E402
    AssemblyError,
    assemble,
    merge_pdfs,
    page_count,
    parse_page_range,
    plan_merge,
    split_pdf,
)


@pytest.fixture
def sample_dir(tmp_path):
    make_pdf(tmp_path / "StandardIRReport.pdf", "StandardIRReport.pdf", 9)
    make_pdf(tmp_path / "A.pdf", "A.pdf", 3)
    make_pdf(tmp_path / "B.pdf", "B.pdf", 2)
    return tmp_path


class TestParsePageRange:
    def test_single_page(self):
        assert parse_page_range("1", 9) == [0]

    def test_open_ended_range_runs_to_the_end(self):
        assert parse_page_range("2-", 5) == [1, 2, 3, 4]

    def test_closed_range(self):
        assert parse_page_range("3-5", 9) == [2, 3, 4]

    def test_comma_separated(self):
        assert parse_page_range("1,4-5", 9) == [0, 3, 4]

    def test_range_is_clamped_to_the_document(self):
        assert parse_page_range("8-99", 9) == [7, 8]

    def test_rejects_range_starting_past_the_end(self):
        with pytest.raises(AssemblyError, match="past the end"):
            parse_page_range("12-14", 9)

    def test_rejects_backwards_range(self):
        with pytest.raises(AssemblyError, match="invalid page range"):
            parse_page_range("5-2", 9)

    def test_rejects_empty(self):
        with pytest.raises(AssemblyError):
            parse_page_range("  ", 9)


class TestSplit:
    def test_cover_and_body_partition_the_source(self, sample_dir):
        written = split_pdf(
            sample_dir / "StandardIRReport.pdf",
            [
                {"name": "Cover.pdf", "pages": "1"},
                {"name": "StandardIRReport no cover.pdf", "pages": "2-"},
            ],
            sample_dir,
        )
        assert [p.name for p in written] == [
            "Cover.pdf",
            "StandardIRReport no cover.pdf",
        ]
        assert page_count(written[0]) == 1
        assert page_count(written[1]) == 8
        # No page is lost or duplicated.
        assert page_count(written[0]) + page_count(written[1]) == 9

    def test_refuses_a_single_page_source(self, tmp_path):
        make_pdf(tmp_path / "one.pdf", "one.pdf", 1)
        with pytest.raises(AssemblyError, match="at least 2"):
            split_pdf(
                tmp_path / "one.pdf",
                [{"name": "Cover.pdf", "pages": "1"}],
                tmp_path,
            )

    def test_missing_source(self, tmp_path):
        with pytest.raises(AssemblyError, match="not found"):
            split_pdf(tmp_path / "nope.pdf", [], tmp_path)


class TestPlanMerge:
    def test_reports_every_missing_document_at_once(self, sample_dir):
        plan = plan_merge(["A.pdf", "gone.pdf", "B.pdf", "also-gone.pdf"], sample_dir)
        assert not plan.ok
        assert plan.missing == ["gone.pdf", "also-gone.pdf"]
        assert [p.name for p in plan.present] == ["A.pdf", "B.pdf"]

    def test_ok_when_everything_present(self, sample_dir):
        plan = plan_merge(["A.pdf", "B.pdf"], sample_dir)
        assert plan.ok
        assert plan.missing == []


class TestMerge:
    def test_page_counts_add_up(self, sample_dir):
        out = merge_pdfs(
            [sample_dir / "A.pdf", sample_dir / "B.pdf"], sample_dir / "out.pdf"
        )
        assert page_count(out) == 5

    def test_order_is_preserved(self, sample_dir):
        from pypdf import PdfReader

        out = merge_pdfs(
            [sample_dir / "B.pdf", sample_dir / "A.pdf"], sample_dir / "out.pdf"
        )
        first_page_text = PdfReader(str(out)).pages[0].extract_text()
        assert "B.pdf" in first_page_text

    def test_rejects_a_non_pdf(self, sample_dir):
        junk = sample_dir / "junk.pdf"
        junk.write_text("this is not a pdf")
        with pytest.raises(AssemblyError, match="not a readable PDF"):
            merge_pdfs([sample_dir / "A.pdf", junk], sample_dir / "out.pdf")

    def test_rejects_empty_input_list(self, sample_dir):
        with pytest.raises(AssemblyError, match="nothing to merge"):
            merge_pdfs([], sample_dir / "out.pdf")

    def test_creates_missing_output_directory(self, sample_dir):
        out = merge_pdfs(
            [sample_dir / "A.pdf"], sample_dir / "deep" / "nested" / "out.pdf"
        )
        assert out.exists()


class TestAssemble:
    def test_refuses_to_build_an_incomplete_report(self, sample_dir):
        with pytest.raises(AssemblyError) as excinfo:
            assemble(["A.pdf", "missing-one.pdf"], sample_dir, sample_dir / "o.pdf")
        message = str(excinfo.value)
        assert "missing 1 document" in message
        assert "missing-one.pdf" in message
        # The partial output must not exist.
        assert not (sample_dir / "o.pdf").exists()

    def test_builds_when_complete(self, sample_dir):
        out = assemble(["A.pdf", "B.pdf"], sample_dir, sample_dir / "o.pdf")
        assert out.exists()
        assert page_count(out) == 5
