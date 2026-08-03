"""One run at a time, per capability, per installation.

A coworker double-clicks a launcher, nothing appears to happen for twenty
seconds while a browser starts, and they double-click it again. Without a lock
that is two live portal sessions, two sets of customer documents on disk, and
two runs writing the same knowledge store -- and the second one will look like
it worked.

So a run takes a lock before it starts and releases it when it stops. The lock
is a file holding the process id, the run id and the time, which makes the
refusal explainable:

    Another run is already going: visit-findings-20260803T132708+0000,
    started 40 seconds ago (process 51234).

**Stale locks are the hard part.** A process killed with SIGKILL never releases
anything, and a lock that outlives its process turns a crash into a permanent
outage that only somebody who knows about lock files can clear. So the holder's
liveness is checked rather than trusted: if the recorded process is gone, the
lock is stale and is taken over, with a note saying so. A coworker never has to
know this file exists.

Deliberately not a cross-machine lock. Two people on two laptops running
against the same portal is a real thing, and this cannot prevent it -- the
portal would have to. This prevents the accident that actually happens, which
is one person and one impatient double-click.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AlreadyRunning(RuntimeError):
    """Another run of this capability holds the lock, and is alive."""


@dataclass
class LockInfo:
    """Who holds the lock, and since when."""

    pid: int = 0
    run_id: str = ""
    operation: str = ""
    started_at: str = ""

    def age_seconds(self, now: datetime | None = None) -> float | None:
        if not self.started_at:
            return None
        try:
            started = datetime.fromisoformat(self.started_at)
        except ValueError:
            return None
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        return ((now or datetime.now(timezone.utc)) - started).total_seconds()

    def describe(self) -> str:
        age = self.age_seconds()
        when = f", started {age:.0f} seconds ago" if age is not None else ""
        return f"{self.run_id or self.operation or 'a run'}{when} (process {self.pid})"

    def to_dict(self) -> dict[str, Any]:
        return {
            "pid": self.pid, "run_id": self.run_id,
            "operation": self.operation, "started_at": self.started_at,
        }


def process_alive(pid: int) -> bool:
    """Whether a process id is still running. Never raises."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # It exists and belongs to somebody else. Alive is the safe answer.
        return True
    except OSError:                                         # pragma: no cover
        return False
    return True


class RunLock:
    """A file lock that refuses a second run and forgives a dead one.

    Used as a context manager::

        with RunLock(work_root, "visit-findings", run_id):
            ...
    """

    def __init__(
        self,
        work_root: Path | str,
        operation: str,
        run_id: str = "",
        *,
        clock: Any = None,
    ) -> None:
        self.path = Path(work_root) / f".{operation}.lock"
        self.operation = operation
        self.run_id = run_id
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._held = False
        #: Set when a dead holder's lock was taken over, so the caller can say so.
        self.took_over: LockInfo | None = None

    # -- reading ----------------------------------------------------------
    def read(self) -> LockInfo | None:
        if not self.path.is_file():
            return None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:                                   # noqa: BLE001
            # An unreadable lock is not a reason to refuse forever.
            return LockInfo(pid=0, operation=self.operation)
        return LockInfo(
            pid=int(data.get("pid", 0)),
            run_id=str(data.get("run_id", "")),
            operation=str(data.get("operation", "")),
            started_at=str(data.get("started_at", "")),
        )

    @property
    def held_by_live_process(self) -> LockInfo | None:
        existing = self.read()
        if existing is None:
            return None
        return existing if process_alive(existing.pid) else None

    # -- taking and releasing --------------------------------------------
    def acquire(self) -> "RunLock":
        existing = self.read()
        if existing is not None:
            if process_alive(existing.pid):
                raise AlreadyRunning(
                    f"another run is already going: {existing.describe()}.\n"
                    "    Wait for it to finish, or check on it with:  awe-tegg status"
                )
            # The holder is gone. Taking over rather than leaving a coworker
            # permanently locked out by a crash they cannot diagnose.
            self.took_over = existing

        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "pid": os.getpid(),
            "run_id": self.run_id,
            "operation": self.operation,
            "started_at": self._clock().isoformat(timespec="seconds"),
        }
        self.path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        self._held = True
        return self

    def release(self) -> None:
        """Give up the lock, but only if it is still ours."""
        if not self._held:
            return
        current = self.read()
        if current is not None and current.pid == os.getpid():
            self.path.unlink(missing_ok=True)
        self._held = False

    def __enter__(self) -> "RunLock":
        return self.acquire()

    def __exit__(self, *exc: Any) -> None:
        self.release()
