"""Proof 7 and 8: the second run is the point.

Correcting knowledge is worth nothing if the correction is not spent. So this
drives the whole operation twice against the same portal and the same store, in
two separate executions, and asserts the difference between them:

    run 1   applies the stale record, contradicts it, discovers the route,
            supersedes, and finishes. It pays for discovery.
    run 2   retrieves the replacement and goes straight there. It pays for
            nothing, and that is checked on the portal's side -- run 2 must
            never fetch the dashboard a second time, because a second dashboard
            fetch is what discovery looks like from the server.

Run 3 exists to show what the second run earned: two distinct executions have
now confirmed the procedure, so it is VERIFIED and usable without the candidate
allowance at all.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

# The whole operation drives a real browser; skip rather than fail without one.
pytest.importorskip("playwright")

from awe_knowledge.models import TrustLevel  # noqa: E402
from awe_tegg.checkpoint import COMPLETED, STEPS  # noqa: E402
from awe_tegg.operation import (  # noqa: E402
    PROCEDURE_RECORD_ID,
    STALE_RECORD_ID,
    start,
)

from conftest import TENANT, open_run, record_of  # noqa: E402
from mock_documentation import COMPLETED_COUNT, SITE_VISITS  # noqa: E402


def _run(settings, work_root: Path, run_id: str):
    return start(settings, work_root=work_root, run_id=run_id)


def _fetch_count(portal, path: str) -> int:
    return sum(1 for p in portal.fetched if p.rstrip("/") == path.rstrip("/"))


def test_the_first_run_repairs_and_the_second_reuses(
    portal, store, seeded, settings, credentials, tmp_path
):
    settings.store_root = store.root
    work = tmp_path / "work"

    # -- run 1: find the stale record, correct it ------------------------
    first = _run(settings, work, "run-one")
    assert first.status == COMPLETED, first.human_action_required
    assert first.steps_completed == list(STEPS)
    assert [s["record_id"] for s in first.stale_knowledge] == [STALE_RECORD_ID]
    assert [c["record_id"] for c in first.corrected_knowledge] == [
        PROCEDURE_RECORD_ID
    ]
    assert first.rediscovered is True
    assert len(first.records) == COMPLETED_COUNT
    assert first.rows_on_first_page == len(SITE_VISITS)
    assert first.pages_read == 1

    assert record_of(store, PROCEDURE_RECORD_ID).trust is TrustLevel.CANDIDATE
    assert record_of(store, STALE_RECORD_ID).trust is TrustLevel.INVALID

    # -- run 2: a fresh execution, from the corrected knowledge ----------
    portal.forget_traffic()
    second = _run(settings, work, "run-two")

    assert second.status == COMPLETED, second.human_action_required
    assert [k["record_id"] for k in second.knowledge_used] == [PROCEDURE_RECORD_ID], (
        "the fresh run did not retrieve the replacement procedure"
    )
    assert second.knowledge_used[0]["trust"] == "CANDIDATE"
    assert second.contradictions == []
    assert second.corrected_knowledge == [], "nothing needed correcting the second time"
    assert second.rediscovered is False
    assert len(second.records) == COMPLETED_COUNT

    # Proof 8, checked from the portal's side rather than from ours: a run that
    # rediscovers goes back to the dashboard to read the navigation. This one
    # went to the sign-in, was redirected to the dashboard once, and then
    # straight to Documentation.
    assert _fetch_count(portal, "/sales/gm-dashboard") == 1, (
        f"the fresh run rediscovered the route: {portal.fetched}"
    )
    assert _fetch_count(portal, "/sales/documentation") == 1
    assert portal.mutations == []

    ledger_two = (work / "operations" / "run-two" / "state.json").read_text()
    assert "discovery" not in ledger_two, "run two ran discovery"

    # -- run 3: what the second run earned -------------------------------
    assert record_of(store, PROCEDURE_RECORD_ID).trust is TrustLevel.VERIFIED, (
        "two distinct executions confirmed it; it should no longer be a hypothesis"
    )
    strict = open_run(store, "exec-strict", portal.url, allow_candidate=False)
    assert strict.usable(PROCEDURE_RECORD_ID) is not None, (
        "the corrected procedure should now stand on its own"
    )


def test_the_repaired_route_survives_the_portal_moving_it(
    portal, store, seeded, settings, credentials, tmp_path
):
    """The repair is not hard-wired to one URL: move it and it is found again."""
    settings.store_root = store.root
    work = tmp_path / "work"
    portal.move_documentation("/sales/records-library")

    first = _run(settings, work, "moved-one")
    assert first.status == COMPLETED, first.human_action_required
    record = record_of(store, PROCEDURE_RECORD_ID)
    assert record.payload["route"] == "/sales/records-library"

    portal.forget_traffic()
    second = _run(settings, work, "moved-two")
    assert second.status == COMPLETED
    assert second.corrected_knowledge == []
    assert _fetch_count(portal, "/sales/records-library") == 1


def test_the_operator_output_says_what_happened(
    portal, store, seeded, settings, credentials, tmp_path
):
    """The ten headings are the deliverable; a missing one is a defect."""
    from awe_tegg import report as report_module

    settings.store_root = store.root
    result = _run(settings, tmp_path / "work", "reporting")
    rendered = report_module.render(result)

    for heading in (
        "run id", "status", "steps completed", "records found",
        "knowledge used", "stale knowledge detected",
        "corrected knowledge created", "human action required",
        "external changes performed", "safe resume command",
    ):
        assert heading in rendered, f"the operator output lost {heading!r}"

    assert STALE_RECORD_ID in rendered
    assert PROCEDURE_RECORD_ID in rendered
    assert "VERIFIED -> DEGRADED" in rendered
    assert "python -m awe_tegg resume --run-id reporting" in rendered
    # The one thing the run touched, named rather than hidden.
    assert "client-side view filter" in rendered
    assert "nothing submitted" in rendered


def test_a_run_with_no_stale_knowledge_reports_none_of_it(
    portal, store, seeded, settings, credentials, tmp_path
):
    from awe_tegg import report as report_module

    settings.store_root = store.root
    work = tmp_path / "work"
    _run(settings, work, "clean-one")
    second = _run(settings, work, "clean-two")

    rendered = report_module.render(second)
    assert "everything the run believed still held" in rendered
    assert "nothing needed correcting" in rendered
