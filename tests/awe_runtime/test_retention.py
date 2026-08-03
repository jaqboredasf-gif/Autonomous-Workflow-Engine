"""What is kept, what is swept, and what is never swept without being asked.

Retention is one of the few places where a bug destroys evidence rather than
producing a wrong answer, so the tests here are mostly about refusals.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from awe_runtime import retention

NOW = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)


def _run(root: Path, run_id: str, *, status: str = "completed",
         days_old: float = 0.0, payload_bytes: int = 1024) -> Path:
    folder = root / "operations" / run_id
    (folder / "documents").mkdir(parents=True)
    started = (NOW - timedelta(days=days_old)).isoformat(timespec="seconds")
    (folder / "state.json").write_text(json.dumps({
        "run_id": run_id, "operation": "visit-findings",
        "status": status, "started_at": started,
    }), encoding="utf-8")
    (folder / "documents" / "report.pdf").write_bytes(b"x" * payload_bytes)
    return folder


def test_a_directory_with_no_runs_is_not_an_error(tmp_path):
    assert retention.scan(tmp_path) == []


def test_every_run_is_found_with_its_size_and_age(tmp_path):
    _run(tmp_path, "one", days_old=1, payload_bytes=2048)
    runs = retention.scan(tmp_path)
    assert len(runs) == 1
    assert runs[0].run_id == "one"
    assert runs[0].bytes >= 2048
    assert 0.9 < runs[0].age_days(NOW) < 1.1


def test_runs_come_back_newest_first(tmp_path):
    _run(tmp_path, "older", days_old=10)
    _run(tmp_path, "newer", days_old=1)
    assert [r.run_id for r in retention.scan(tmp_path)] == ["newer", "older"]


# -- what is never swept --------------------------------------------------


def test_the_most_recent_run_is_never_swept_however_old(tmp_path):
    """It is what somebody is looking at, even if the project went quiet."""
    _run(tmp_path, "only", days_old=999)
    removable, kept = retention.sweepable(retention.scan(tmp_path), now=NOW)
    assert removable == []
    assert "most recent" in kept["only"]


@pytest.mark.parametrize("status", ["running", "interrupted", "escalated"])
def test_an_unfinished_run_is_never_swept(tmp_path, status):
    """It is the one still worth resuming."""
    _run(tmp_path, "newest", days_old=0)
    _run(tmp_path, "unfinished", status=status, days_old=999)
    removable, kept = retention.sweepable(retention.scan(tmp_path), now=NOW)
    assert [r.run_id for r in removable] == []
    assert "resuming" in kept["unfinished"]


def test_a_run_whose_ledger_will_not_parse_is_shown_but_not_swept(tmp_path):
    _run(tmp_path, "newest", days_old=0)
    broken = tmp_path / "operations" / "broken"
    broken.mkdir(parents=True)
    (broken / "state.json").write_text("{not json", encoding="utf-8")

    runs = retention.scan(tmp_path)
    assert "broken" in [r.run_id for r in runs]
    assert [r.status for r in runs if r.run_id == "broken"] == ["unreadable"]

    removable, kept = retention.sweepable(runs, now=NOW)
    assert "broken" not in [r.run_id for r in removable]
    assert "broken" in kept


def test_a_run_inside_the_window_is_kept_and_says_how_old_it_is(tmp_path):
    _run(tmp_path, "newest", days_old=0)
    _run(tmp_path, "recent", days_old=5)
    removable, kept = retention.sweepable(
        retention.scan(tmp_path), keep_days=30, now=NOW
    )
    assert removable == []
    assert "5 day(s) old" in kept["recent"] and "limit is 30" in kept["recent"]


# -- what is swept, and only when asked ----------------------------------


def test_an_old_finished_run_that_is_not_the_newest_is_removable(tmp_path):
    _run(tmp_path, "newest", days_old=0)
    _run(tmp_path, "ancient", days_old=90)
    removable, _ = retention.sweepable(
        retention.scan(tmp_path), keep_days=30, now=NOW
    )
    assert [r.run_id for r in removable] == ["ancient"]


def test_selecting_runs_deletes_nothing_by_itself(tmp_path):
    """`sweepable` answers a question. Only `remove` acts."""
    _run(tmp_path, "newest", days_old=0)
    folder = _run(tmp_path, "ancient", days_old=90)
    retention.sweepable(retention.scan(tmp_path), keep_days=30, now=NOW)
    assert folder.exists(), "selecting must not delete"


def test_removal_reports_what_actually_went(tmp_path):
    _run(tmp_path, "newest", days_old=0)
    _run(tmp_path, "ancient", days_old=90, payload_bytes=4096)
    removable, _ = retention.sweepable(
        retention.scan(tmp_path), keep_days=30, now=NOW
    )
    folders, freed, failures = retention.remove(removable)
    assert folders == 1 and freed >= 4096 and failures == []
    assert not (tmp_path / "operations" / "ancient").exists()
    assert (tmp_path / "operations" / "newest").exists()


def test_a_shorter_window_sweeps_more(tmp_path):
    _run(tmp_path, "newest", days_old=0)
    _run(tmp_path, "middle", days_old=10)
    assert retention.sweepable(retention.scan(tmp_path), keep_days=30, now=NOW)[0] == []
    removable, _ = retention.sweepable(
        retention.scan(tmp_path), keep_days=7, now=NOW
    )
    assert [r.run_id for r in removable] == ["middle"]


def test_sizes_are_reported_in_units_a_person_reads():
    assert retention.human_bytes(512) == "512 B"
    assert retention.human_bytes(2048).endswith("KB")
    assert retention.human_bytes(5 * 1024 * 1024).endswith("MB")
