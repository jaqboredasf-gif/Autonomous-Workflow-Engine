"""Job workspace and manifest behaviour.

The manifest is both the resume point and the audit trail, so the tests that
matter most are the ones about *not* repeating work and *not* losing history.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tegg import canonical, workspace as ws  # noqa: E402


@pytest.fixture
def workspace(tmp_path):
    return ws.Workspace.create(
        tmp_path / "work",
        "visit-71999-20260729",
        customer="Acme Manufacturing",
        site="Plant 3 - Toledo",
        site_visit="71999",
    )


def _file(path: Path, content: bytes = b"hello") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


class TestLayout:
    def test_creates_every_subfolder(self, workspace):
        for name in ws.SUBDIRS:
            assert (workspace.path / name).is_dir()

    def test_manifest_is_written_immediately(self, workspace):
        assert workspace.manifest_path.exists()
        data = json.loads(workspace.manifest_path.read_text())
        assert data["job_id"] == "visit-71999-20260729"
        assert data["customer"] == "Acme Manufacturing"

    def test_new_jobs_require_review_by_default(self, workspace):
        assert workspace.data["review_required"] is True

    def test_job_ids_are_path_safe(self):
        assert "/" not in ws.slugify("a/b c:d")
        assert ws.slugify("") == "job"

    def test_make_job_id_leads_with_the_site_visit(self):
        job_id = ws.make_job_id("71999", "Acme Manufacturing", when="2026-07-29T00:00")
        assert job_id.startswith("71999")
        assert "20260729" in job_id


class TestReopening:
    def test_reopening_preserves_history(self, tmp_path):
        root = tmp_path / "work"
        first = ws.Workspace.create(root, "job-1", customer="Acme")
        first.mark_downloaded(
            canonical.STANDARD_IR, _file(first.source / "StandardIRReport.pdf")
        )

        again = ws.Workspace.create(root, "job-1")
        assert again.data["customer"] == "Acme"
        assert again.record(canonical.STANDARD_IR).status == ws.DOWNLOADED

    def test_find_and_list(self, workspace, tmp_path):
        root = tmp_path / "work"
        assert ws.Workspace.list_jobs(root) == ["visit-71999-20260729"]
        found = ws.Workspace.find(root, "visit-71999-20260729")
        assert found.job_id == workspace.job_id

    def test_listing_an_empty_root_is_not_an_error(self, tmp_path):
        assert ws.Workspace.list_jobs(tmp_path / "nothing") == []

    def test_opening_a_folder_without_a_manifest_fails(self, tmp_path):
        (tmp_path / "empty").mkdir()
        with pytest.raises(FileNotFoundError):
            ws.Workspace.open(tmp_path / "empty")


class TestResume:
    def test_a_fresh_document_is_needed(self, workspace):
        assert workspace.needs(canonical.STANDARD_IR) is True

    def test_a_downloaded_document_is_not_fetched_again(self, workspace):
        path = _file(workspace.source / "StandardIRReport.pdf")
        workspace.mark_downloaded(canonical.STANDARD_IR, path)
        assert workspace.needs(canonical.STANDARD_IR) is False

    def test_force_overrides_a_settled_document(self, workspace):
        path = _file(workspace.source / "StandardIRReport.pdf")
        workspace.mark_downloaded(canonical.STANDARD_IR, path)
        assert workspace.needs(canonical.STANDARD_IR, force=True) is True

    def test_a_recorded_file_deleted_from_disk_is_needed_again(self, workspace):
        path = _file(workspace.source / "StandardIRReport.pdf")
        workspace.mark_downloaded(canonical.STANDARD_IR, path)
        path.unlink()
        assert workspace.needs(canonical.STANDARD_IR) is True

    def test_a_failed_document_is_retried(self, workspace):
        workspace.mark_failed(canonical.EDS_ALL_PROBLEMS, "no agreement")
        assert workspace.needs(canonical.EDS_ALL_PROBLEMS) is True

    def test_resume_survives_reopening(self, tmp_path):
        root = tmp_path / "work"
        first = ws.Workspace.create(root, "job-2")
        _file(first.source / "ProblemCountSummary.pdf")
        first.mark_downloaded(
            canonical.PROBLEM_COUNT_SUMMARY, first.source / "ProblemCountSummary.pdf"
        )
        again = ws.Workspace.find(root, "job-2")
        assert again.needs(canonical.PROBLEM_COUNT_SUMMARY) is False


class TestRecords:
    def test_download_records_checksum_and_timestamp(self, workspace):
        path = _file(workspace.source / "ProblemCountSummary.pdf", b"abc")
        record = workspace.mark_downloaded(
            canonical.PROBLEM_COUNT_SUMMARY, path, discovered_name="Problem Count Summary"
        )
        assert record.checksum == ws.checksum(path)
        assert record.downloaded_at
        assert record.discovered_name == "Problem Count Summary"
        assert record.source_filename == "ProblemCountSummary.pdf"

    def test_paths_are_stored_relative_so_the_job_can_move(self, workspace):
        path = _file(workspace.source / "ProblemCountSummary.pdf")
        record = workspace.mark_downloaded(canonical.PROBLEM_COUNT_SUMMARY, path)
        assert not Path(record.local_path).is_absolute()
        assert record.local_path.startswith("source")
        assert workspace.resolve(record.local_path) == path

    def test_failure_reason_is_kept(self, workspace):
        workspace.mark_failed(
            canonical.EDS_ALL_PROBLEMS, "currently no agreements", status=ws.UNAVAILABLE
        )
        record = workspace.record(canonical.EDS_ALL_PROBLEMS)
        assert record.status == ws.UNAVAILABLE
        assert "no agreements" in record.failure_reason

    def test_a_later_success_clears_an_earlier_failure(self, workspace):
        workspace.mark_failed(canonical.STANDARD_IR, "timed out")
        path = _file(workspace.source / "StandardIRReport.pdf")
        record = workspace.mark_downloaded(canonical.STANDARD_IR, path)
        assert record.failure_reason == ""
        assert record.status == ws.DOWNLOADED

    def test_checksum_detects_a_changed_file(self, tmp_path):
        one = _file(tmp_path / "a.pdf", b"one")
        two = _file(tmp_path / "b.pdf", b"two")
        assert ws.checksum(one) != ws.checksum(two)


class TestReviewAndEvents:
    def test_review_reasons_do_not_duplicate(self, workspace):
        workspace.require_review("certificate not edited")
        workspace.require_review("certificate not edited")
        assert workspace.data["review_reasons"].count("certificate not edited") == 1

    def test_events_are_appended(self, workspace):
        workspace.log_event("portal", "logged in")
        workspace.log_event("portal", "listed visits")
        assert len(workspace.data["events"]) == 2

    def test_summary_mentions_review(self, workspace):
        workspace.require_review("tick section B by hand")
        assert "HUMAN REVIEW REQUIRED" in workspace.summary()
        assert "tick section B by hand" in workspace.summary()


class TestDurability:
    def test_save_is_atomic_and_leaves_no_temp_file(self, workspace):
        workspace.save()
        assert not list(workspace.path.glob("*.tmp"))

    def test_manifest_stays_valid_json_after_many_writes(self, workspace):
        for index in range(10):
            workspace.log_event("test", f"event {index}")
        json.loads(workspace.manifest_path.read_text())
