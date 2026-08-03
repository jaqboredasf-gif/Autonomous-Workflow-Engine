"""Proof 9: an interrupted run continues from where it got to, and says so.

Resume is where automation usually lies. The two honest properties are:

  * **a durable checkpoint is written after every verified step**, not at the
    end, so a process that dies leaves the truth behind it;
  * **a resume redoes the preconditions and nothing else.** A browser session
    cannot be checkpointed, so signing in happens again; discovering the route
    already happened, was written down, and does not.

The third property is the one operators actually care about: resuming a run
that already finished does *not* sign in again and does *not* re-read a
customer's records. It reprints the answer.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

# The whole operation drives a real browser; skip rather than fail without one.
pytest.importorskip("playwright")

from awe_tegg.checkpoint import (  # noqa: E402
    COMPLETED,
    INTERRUPTED,
    PRECONDITION_STEPS,
    STEPS,
    RunLedger,
)
from awe_tegg.operation import PROCEDURE_RECORD_ID, resume, start  # noqa: E402

from conftest import record_of  # noqa: E402
from mock_documentation import COMPLETED_COUNT  # noqa: E402


class Boom(RuntimeError):
    """A crash that is not the operation's fault, injected at a chosen step."""


def _stop_at(step_name: str):
    seen: list[str] = []

    def hook(step: str) -> None:
        seen.append(step)
        if step == step_name:
            raise Boom(f"process died at {step}")

    hook.seen = seen                                        # type: ignore[attr-defined]
    return hook


# -- checkpointing --------------------------------------------------------
def test_every_verified_step_is_durable_the_moment_it_is_verified(
    portal, store, seeded, settings, credentials, tmp_path
):
    work = tmp_path / "work"
    settings.store_root = store.root
    written: list[list[str]] = []

    def watch(step: str) -> None:
        # Read the ledger off disk, not out of the object, before each step.
        path = work / "operations" / "watched" / "state.json"
        if path.exists():
            import json

            written.append(
                [s["step"] for s in json.loads(path.read_text())["steps"]]
            )

    start(settings, work_root=work, run_id="watched", on_step=watch)

    assert written[0] == [], "the ledger existed before any step was verified"
    # By the time each step starts, every earlier step is already on disk.
    for index, snapshot in enumerate(written):
        assert snapshot == list(STEPS[:index]), (
            f"before step {index} the disk held {snapshot}"
        )


def test_an_interrupted_run_leaves_its_progress_on_disk(
    portal, store, seeded, settings, credentials, tmp_path
):
    settings.store_root = store.root
    work = tmp_path / "work"
    with pytest.raises(Boom):
        start(settings, work_root=work, run_id="crashed",
              on_step=_stop_at("list_records"))

    ledger = RunLedger.find(work, "crashed")
    assert ledger.status == INTERRUPTED
    assert ledger.completed_steps() == [
        "open_knowledge", "sign_in", "locate_workspace",
        "reach_documentation", "verify_documentation",
    ]
    assert ledger.next_step() == "list_records"
    assert ledger.resume_command() == "python -m awe_tegg resume --run-id crashed"
    # The expensive part survived the crash.
    assert ledger.data["corrected_knowledge"]
    assert record_of(store, PROCEDURE_RECORD_ID) is not None


# -- resuming -------------------------------------------------------------
def test_resume_continues_from_the_last_verified_checkpoint(
    portal, store, seeded, settings, credentials, tmp_path
):
    settings.store_root = store.root
    work = tmp_path / "work"
    with pytest.raises(Boom):
        start(settings, work_root=work, run_id="resumable",
              on_step=_stop_at("list_records"))

    ledger = RunLedger.find(work, "resumable")
    assert ledger.resume_point() == "sign_in", (
        "a session is a precondition, so a resume re-establishes it"
    )
    # What the interrupted attempt had already corrected. The resume must add
    # nothing to this: the ledger is the *run's* record, so the entry stays --
    # what would prove a rediscovery is a second one.
    corrected_before = list(ledger.data["corrected_knowledge"])
    contradictions_before = list(ledger.data["contradictions"])
    assert len(corrected_before) == 1
    assert len(contradictions_before) == 1

    portal.forget_traffic()
    hook = _stop_at("__never__")
    result = resume(settings, "resumable", work_root=work, on_step=hook)

    assert result.status == COMPLETED
    assert result.steps_completed == list(STEPS)
    assert len(result.records) == COMPLETED_COUNT
    assert RunLedger.find(work, "resumable").data["resumes"] == 1

    # What the resume redid, and what it did not.
    assert set(hook.seen) >= PRECONDITION_STEPS
    assert "list_records" in hook.seen
    assert result.corrected_knowledge == corrected_before, (
        "the resume rediscovered a route that had already been corrected"
    )
    assert result.contradictions == contradictions_before, (
        "the resume contradicted knowledge a second time"
    )
    assert sum(1 for p in portal.fetched if p == "/sales/gm-dashboard") == 1, (
        f"the resume ran discovery again: {portal.fetched}"
    )


def test_resume_uses_the_knowledge_the_interrupted_run_wrote(
    portal, store, seeded, settings, credentials, tmp_path
):
    settings.store_root = store.root
    work = tmp_path / "work"
    with pytest.raises(Boom):
        start(settings, work_root=work, run_id="handover",
              on_step=_stop_at("list_records"))

    result = resume(settings, "handover", work_root=work)
    assert [k["record_id"] for k in result.knowledge_used][-1] == PROCEDURE_RECORD_ID


def test_resuming_a_finished_run_reads_nothing_again(
    portal, store, seeded, settings, credentials, tmp_path
):
    """Already-completed behaviour: reprint the answer, touch nothing."""
    settings.store_root = store.root
    work = tmp_path / "work"
    first = start(settings, work_root=work, run_id="already-done")
    assert first.status == COMPLETED

    portal.forget_traffic()
    again = resume(settings, "already-done", work_root=work)

    assert again.status == COMPLETED
    assert again.records == first.records
    assert portal.fetched == [], (
        f"resuming a finished run touched the portal: {portal.fetched}"
    )
    assert portal.mutations == []
    assert RunLedger.find(work, "already-done").data["resumes"] == 0
    assert any("already complete" in note for note in again.notes)


def test_resuming_an_unknown_run_says_so(settings, tmp_path):
    with pytest.raises(FileNotFoundError):
        resume(settings, "no-such-run", work_root=tmp_path / "work")


def test_the_ledger_survives_a_write_that_never_finished(tmp_path):
    """An interrupted save must not truncate the previous ledger."""
    ledger = RunLedger.create(
        tmp_path / "work", "atomic",
        operation="documentation-read", tenant="lippolis",
        integration="tegg-pro", environment="production",
        base_url="http://127.0.0.1", credential_source="environment",
    )
    ledger.checkpoint("open_knowledge", "first")
    before = ledger.state_path.read_text(encoding="utf-8")

    # A save that raises part-way leaves the temporary file behind, never a
    # half-written state.json.
    ledger.data["records"] = {"unserialisable": object()}
    with pytest.raises(TypeError):
        ledger.save()
    assert ledger.state_path.read_text(encoding="utf-8") == before

    reopened = RunLedger.open(ledger.path)
    assert reopened.completed_steps() == ["open_knowledge"]
