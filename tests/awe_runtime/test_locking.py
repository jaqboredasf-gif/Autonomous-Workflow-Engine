"""One run at a time, and a crash that does not lock anybody out.

The accident this prevents is specific: a coworker double-clicks a launcher,
sees nothing for twenty seconds while a browser starts, and double-clicks
again. Two live portal sessions, two sets of customer documents, and the second
one looks like it worked.

The failure mode it must avoid causing is equally specific: a lock that
outlives its process turns one crash into a permanent outage that only somebody
who knows about lock files can clear.
"""

from __future__ import annotations

import json
import os

import pytest

from awe_runtime import locking


def test_a_lock_is_taken_and_released(tmp_path):
    lock = locking.RunLock(tmp_path, "demo", "run-1")
    with lock:
        assert lock.path.exists()
        held = lock.read()
        assert held.pid == os.getpid() and held.run_id == "run-1"
    assert not lock.path.exists()


def test_a_second_run_is_refused_while_the_first_is_alive(tmp_path):
    with locking.RunLock(tmp_path, "demo", "first"):
        with pytest.raises(locking.AlreadyRunning) as caught:
            locking.RunLock(tmp_path, "demo", "second").acquire()
    message = str(caught.value)
    assert "already going" in message
    assert "first" in message, "it must name the run that holds it"
    assert "status" in message, "it must say how to check on it"


def test_a_dead_holders_lock_is_taken_over_rather_than_obeyed(tmp_path):
    """A SIGKILL never releases anything. That must not lock a coworker out."""
    stale = tmp_path / ".demo.lock"
    stale.write_text(json.dumps({
        "pid": 999_999, "run_id": "crashed", "operation": "demo",
        "started_at": "2026-08-03T10:00:00+00:00",
    }), encoding="utf-8")

    lock = locking.RunLock(tmp_path, "demo", "new-run")
    with lock:
        assert lock.took_over is not None
        assert lock.took_over.run_id == "crashed"
        assert lock.read().run_id == "new-run"


def test_an_unreadable_lock_does_not_block_forever(tmp_path):
    (tmp_path / ".demo.lock").write_text("{not json", encoding="utf-8")
    with locking.RunLock(tmp_path, "demo", "new") as lock:
        assert lock.read().run_id == "new"


def test_releasing_somebody_elses_lock_is_refused(tmp_path):
    """Two processes, and the loser must not delete the winner's lock."""
    lock = locking.RunLock(tmp_path, "demo", "mine")
    lock.acquire()
    lock.path.write_text(json.dumps({
        "pid": 999_999, "run_id": "theirs", "operation": "demo",
        "started_at": "2026-08-03T10:00:00+00:00",
    }), encoding="utf-8")
    lock.release()
    assert lock.path.exists(), "it was no longer ours to delete"


def test_different_operations_do_not_block_each_other(tmp_path):
    with locking.RunLock(tmp_path, "alpha", "a"):
        with locking.RunLock(tmp_path, "beta", "b") as other:
            assert other.path.exists()


def test_a_process_that_does_not_exist_is_not_alive():
    assert locking.process_alive(999_999) is False
    assert locking.process_alive(0) is False
    assert locking.process_alive(os.getpid()) is True


def test_the_refusal_says_how_long_the_other_run_has_been_going(tmp_path):
    lock = locking.RunLock(tmp_path, "demo", "first")
    with lock:
        info = lock.read()
        assert info.age_seconds() is not None
        assert "seconds ago" in info.describe()
