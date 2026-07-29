import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tegg.resolve import missing, normalize, resolve_all, resolve_one  # noqa: E402


def touch(directory: Path, name: str, age: float = 0.0) -> Path:
    path = directory / name
    path.write_bytes(b"%PDF-1.4 stub")
    if age:
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
    return path


class TestNormalize:
    def test_strips_punctuation_and_case(self):
        assert normalize("Equipment Inventory_Short-Form.PDF") == (
            "equipmentinventoryshortform"
        )

    def test_drops_the_extension(self):
        assert normalize("Cover.pdf") == "cover"


class TestExactMatch:
    def test_prefers_exact_name(self, tmp_path):
        touch(tmp_path, "Cover.pdf")
        result = resolve_one("Cover.pdf", [tmp_path])
        assert result.found
        assert result.how == "exact"

    def test_case_insensitive_fallback(self, tmp_path):
        touch(tmp_path, "cover.PDF")
        result = resolve_one("Cover.pdf", [tmp_path])
        assert result.found
        assert result.how == "ci-name"


class TestFuzzyMatch:
    def test_matches_browser_duplicate_suffix(self, tmp_path):
        touch(tmp_path, "ProblemCountSummary (1).pdf")
        result = resolve_one("ProblemCountSummary.pdf", [tmp_path])
        assert result.found
        assert result.how == "prefix"

    def test_matches_timestamped_export(self, tmp_path):
        touch(tmp_path, "EquipmentInventoryShortForm_20260514.pdf")
        result = resolve_one("EquipmentInventoryShortForm.pdf", [tmp_path])
        assert result.found

    def test_matches_spaced_out_name(self, tmp_path):
        touch(tmp_path, "Equipment Inventory Short Form.pdf")
        result = resolve_one("EquipmentInventoryShortForm.pdf", [tmp_path])
        assert result.found
        assert result.how == "normalized"

    def test_reports_nothing_when_absent(self, tmp_path):
        touch(tmp_path, "SomethingElse.pdf")
        result = resolve_one("ProblemCountSummary.pdf", [tmp_path])
        assert not result.found
        assert result.how == "missing"


class TestClaiming:
    def test_exact_match_is_not_stolen_by_a_prefix_match(self, tmp_path):
        """The critical case: two documents share a name prefix.

        'EquipmentInventoryShortForm.pdf' must not be consumed as a prefix
        match for a shorter wanted name before its true owner claims it.
        """
        touch(tmp_path, "EquipmentInventory.pdf")
        touch(tmp_path, "EquipmentInventoryShortForm.pdf")

        results = resolve_all(
            ["EquipmentInventory.pdf", "EquipmentInventoryShortForm.pdf"], [tmp_path]
        )
        assert results[0].path.name == "EquipmentInventory.pdf"
        assert results[1].path.name == "EquipmentInventoryShortForm.pdf"

    def test_a_file_is_never_used_twice(self, tmp_path):
        touch(tmp_path, "Report.pdf")
        results = resolve_all(["Report.pdf", "ReportOther.pdf"], [tmp_path])
        assert results[0].found
        assert not results[1].found

    def test_newest_wins_and_others_are_reported(self, tmp_path):
        touch(tmp_path, "ProblemCountSummary (1).pdf", age=500)
        newest = touch(tmp_path, "ProblemCountSummary (2).pdf", age=0)
        result = resolve_one("ProblemCountSummary.pdf", [tmp_path])
        assert result.path == newest.resolve()
        assert result.ambiguous
        assert len(result.alternates) == 1


class TestSearchDirs:
    def test_searches_multiple_directories(self, tmp_path):
        downloads = tmp_path / "downloads"
        static = tmp_path / "static"
        downloads.mkdir()
        static.mkdir()
        touch(downloads, "Cover.pdf")
        touch(static, "ESA Table of Contents.pdf")

        results = resolve_all(
            ["Cover.pdf", "ESA Table of Contents.pdf"], [downloads, static]
        )
        assert all(r.found for r in results)

    def test_ignores_a_missing_directory(self, tmp_path):
        touch(tmp_path, "Cover.pdf")
        results = resolve_all(["Cover.pdf"], [tmp_path, tmp_path / "nope"])
        assert results[0].found

    def test_ignores_non_document_files(self, tmp_path):
        touch(tmp_path, "Cover.txt")
        assert not resolve_one("Cover.pdf", [tmp_path]).found


class TestMissingHelper:
    def test_lists_only_unfound(self, tmp_path):
        touch(tmp_path, "A.pdf")
        results = resolve_all(["A.pdf", "B.pdf", "C.pdf"], [tmp_path])
        assert missing(results) == ["B.pdf", "C.pdf"]
