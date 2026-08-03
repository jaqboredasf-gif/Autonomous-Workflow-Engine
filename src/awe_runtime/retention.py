"""What happens to a run's files after the run.

Every AWE capability that does real work leaves evidence behind: the ledger, the
screenshots, the documents it fetched, the output it produced. That evidence is
the reason the capability can be trusted -- and it is also, usually, somebody's
customer data sitting on a laptop with no expiry date.

Nobody deletes what they have not been told exists. So this module does three
things and refuses a fourth:

  * **counts** what is on disk, so an operator can see it;
  * **selects** what is old enough to remove, by a stated rule;
  * **removes** it, only when asked, and reports exactly what went;
  * **never** deletes anything on its own, on a schedule, or as a side effect
    of another command. A capability that quietly tidies away the evidence for
    a result somebody is about to be asked to defend is worse than one that
    fills a disk.

The rule is deliberately simple and explainable in one sentence, because a
retention policy nobody can state is a retention policy nobody follows: *a run
folder may be removed when it is older than N days, unless it is the most
recent one, and unless it never finished.*

The two exceptions are the point. The most recent run is what somebody is
looking at. An unfinished run is the one still worth resuming.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

#: How long a finished run's evidence is kept by default. Thirty days is long
#: enough to answer "what did it say last month" and short enough that a laptop
#: does not accumulate a year of customer documents.
DEFAULT_KEEP_DAYS = 30

#: Statuses that mean the run is not finished, and is therefore never swept.
UNFINISHED = frozenset({"running", "interrupted", "escalated"})


@dataclass
class RunInfo:
    """One run folder on disk, and what is known about it without opening much."""

    path: Path
    run_id: str = ""
    operation: str = ""
    status: str = "unknown"
    started_at: str = ""
    bytes: int = 0
    files: int = 0

    @property
    def unfinished(self) -> bool:
        return self.status in UNFINISHED

    def age_days(self, now: datetime | None = None) -> float | None:
        if not self.started_at:
            return None
        try:
            started = datetime.fromisoformat(self.started_at)
        except ValueError:
            return None
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        return ((now or datetime.now(timezone.utc)) - started).total_seconds() / 86400

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id, "operation": self.operation,
            "status": self.status, "started_at": self.started_at,
            "bytes": self.bytes, "files": self.files, "path": str(self.path),
        }


def scan(work_root: Path | str) -> list[RunInfo]:
    """Every run folder under ``work_root``, newest first."""
    directory = Path(work_root) / "operations"
    if not directory.is_dir():
        return []

    runs: list[RunInfo] = []
    for child in directory.iterdir():
        state = child / "state.json"
        if not state.is_file():
            continue
        info = RunInfo(path=child, run_id=child.name)
        try:
            data = json.loads(state.read_text(encoding="utf-8"))
            info.run_id = str(data.get("run_id", child.name))
            info.operation = str(data.get("operation", ""))
            info.status = str(data.get("status", "unknown"))
            info.started_at = str(data.get("started_at", ""))
        except Exception:                                   # noqa: BLE001
            # A folder whose ledger will not parse is still a folder taking up
            # space, and is still something an operator should be shown.
            info.status = "unreadable"
        info.bytes, info.files = _size_of(child)
        runs.append(info)

    runs.sort(key=lambda r: (r.started_at, r.run_id), reverse=True)
    return runs


def sweepable(
    runs: Iterable[RunInfo],
    *,
    keep_days: int = DEFAULT_KEEP_DAYS,
    now: datetime | None = None,
) -> tuple[list[RunInfo], dict[str, str]]:
    """Which runs may be removed, and why each of the others is being kept.

    Returns the removable ones and a reason for every run that is not, so the
    operator sees the whole picture rather than a number.
    """
    runs = list(runs)
    kept: dict[str, str] = {}
    removable: list[RunInfo] = []
    cutoff = keep_days

    for index, run in enumerate(runs):
        if index == 0:
            kept[run.run_id] = "the most recent run -- this is what you are looking at"
            continue
        if run.unfinished:
            kept[run.run_id] = f"{run.status}; still worth resuming"
            continue
        age = run.age_days(now)
        if age is None:
            kept[run.run_id] = "its start time could not be read, so its age is unknown"
            continue
        if age < cutoff:
            kept[run.run_id] = f"{age:.0f} day(s) old; the limit is {cutoff}"
            continue
        removable.append(run)
    return removable, kept


def remove(runs: Iterable[RunInfo]) -> tuple[int, int, list[str]]:
    """Delete the given run folders. Returns (folders, bytes, failures)."""
    folders = freed = 0
    failures: list[str] = []
    for run in runs:
        try:
            size = run.bytes
            shutil.rmtree(run.path)
            folders += 1
            freed += size
        except Exception as error:                          # noqa: BLE001
            failures.append(f"{run.run_id}: {error}")
    return folders, freed, failures


def human_bytes(count: int) -> str:
    step = float(count)
    for unit in ("B", "KB", "MB", "GB"):
        if step < 1024 or unit == "GB":
            return f"{step:,.0f} {unit}" if unit == "B" else f"{step:,.1f} {unit}"
        step /= 1024
    return f"{count} B"


def _size_of(directory: Path) -> tuple[int, int]:
    total = files = 0
    for path in directory.rglob("*"):
        if path.is_file():
            try:
                total += path.stat().st_size
                files += 1
            except OSError:                                 # pragma: no cover
                continue
    return total, files


def older_than(days: int, now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)) - timedelta(days=days)
