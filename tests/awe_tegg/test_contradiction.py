"""Proof 1 and 2: the portal is allowed to disagree, and disagreement costs.

The starting condition is the real one. ``navigation:documentation-area`` is
VERIFIED, vouched for by two distinct executions, and completely useless: it
describes the area in a sentence and carries nothing a run can check. Against a
portal whose route renders a second after it loads, applying that record as
written cannot succeed -- and the system's job is to notice that rather than to
retry, and to stop counting the record as working.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

from awe_knowledge.models import TrustLevel  # noqa: E402
from awe_tegg import markers as marker_module  # noqa: E402
from awe_tegg.checkpoint import RunLedger  # noqa: E402
from awe_tegg.guard import Budget, ReadOnlyPage  # noqa: E402
from awe_tegg.operation import (  # noqa: E402
    STALE_RECORD_ID,
    Applied,
    apply_navigation,
    navigation_knowledge,
    reach_documentation,
)

from conftest import TENANT, open_run, record_of, trust_of  # noqa: E402


def _ledger(tmp_path: Path, portal) -> RunLedger:
    return RunLedger.create(
        tmp_path / "work", "test-run",
        operation="documentation-read", tenant=TENANT,
        integration="tegg-pro", environment="production",
        base_url=portal.url, credential_source="environment",
    )


def _page(browser, portal, *, actions: int = 12):
    context = browser.new_context()
    page = context.new_page()
    budget = Budget(
        max_actions=actions, max_seconds=60.0,
        allowed_hosts=("127.0.0.1", "localhost"),
    )
    return context, ReadOnlyPage(page, budget)


def test_stale_navigation_knowledge_is_applied_as_written_and_fails(
    browser, portal, store, seeded
):
    """The record instructs one navigation and no wait, so that is what runs.

    This is the part it would be easy to cheat. Silently adding a settle step
    in code would make the stale record 'work' and the defect would survive
    unrecorded, so ``apply_navigation`` performs the record's own steps and
    nothing more.
    """
    run = open_run(store, "exec-contradiction", portal.url)
    record = navigation_knowledge(run)
    assert record.record_id == STALE_RECORD_ID
    assert record.trust is TrustLevel.VERIFIED

    context, page = _page(browser, portal)
    try:
        applied = apply_navigation(record, page, base_url=portal.url)
    finally:
        context.close()

    assert isinstance(applied, Applied)
    assert [s["action"] for s in applied.steps] == ["goto"], (
        "a record with no settle step must not be given one"
    )
    assert applied.settle_ms == 0
    assert not applied.ok
    assert "empty shell" in applied.verdict["reason"]


def test_the_contradiction_is_recorded_with_structure_not_a_log_line(
    browser, portal, store, seeded, tmp_path
):
    run = open_run(store, "exec-structured", portal.url)
    ledger = _ledger(tmp_path, portal)
    context, page = _page(browser, portal)
    try:
        reach_documentation(
            run, page, ledger,
            base_url=portal.url,
            dashboard_url=portal.url + "/sales/gm-dashboard",
            settle_budget_ms=8000,
        )
    finally:
        context.close()
    run.close(note="test")

    assert len(ledger.data["contradictions"]) == 1
    contradiction = ledger.data["contradictions"][0]
    assert contradiction["record_id"] == STALE_RECORD_ID
    assert contradiction["field"] == "expected_result"
    assert contradiction["believed"] == "the site-visit list is on screen"
    assert contradiction["believed_version"] == 5
    assert contradiction["trust_before"] == "VERIFIED"
    assert contradiction["trust_after"] == "DEGRADED"
    assert contradiction["observed"]["ok"] is False
    assert contradiction["execution_id"] == "exec-structured"

    # And durably, beside the run, not only in memory.
    on_disk = ledger.path / "contradiction-navigation-documentation-area.json"
    assert on_disk.exists()
    assert "the site-visit list is on screen" in on_disk.read_text(encoding="utf-8")


def test_contradicted_knowledge_is_demoted_and_never_reinforced(
    browser, portal, store, seeded, tmp_path
):
    """Proof 2. The record that failed must not come out of the run stronger."""
    before = record_of(store, STALE_RECORD_ID)
    assert before.success_count == 3

    run = open_run(store, "exec-no-reinforcement", portal.url)
    ledger = _ledger(tmp_path, portal)
    context, page = _page(browser, portal)
    try:
        reach_documentation(
            run, page, ledger, base_url=portal.url,
            dashboard_url=portal.url + "/sales/gm-dashboard",
            settle_budget_ms=8000,
        )
    finally:
        context.close()
    report = run.close(note="test")

    after = record_of(store, STALE_RECORD_ID)
    assert after.success_count == before.success_count, (
        "a record that did not work was credited with a success"
    )
    assert after.failure_count == before.failure_count + 1
    assert after.trust is TrustLevel.INVALID, (
        "the failed record should be demoted and then superseded"
    )
    assert after.verified_by_runs == [], (
        "the executions that vouched for it no longer do"
    )
    assert STALE_RECORD_ID not in report.used


def test_the_dead_step_is_attempted_exactly_once(
    browser, portal, store, seeded, tmp_path
):
    """No retry loop. One application, one verdict, one demotion.

    Counted on the portal's side: the route may be *fetched* again later --
    discovery is entitled to try it if the portal is still offering it -- but
    the stale record itself is applied once and its failure is charged once.
    """
    run = open_run(store, "exec-once", portal.url)
    ledger = _ledger(tmp_path, portal)
    context, page = _page(browser, portal)
    try:
        reach_documentation(
            run, page, ledger, base_url=portal.url,
            dashboard_url=portal.url + "/sales/gm-dashboard",
            settle_budget_ms=8000,
        )
    finally:
        context.close()
    run.close(note="test")

    record = record_of(store, STALE_RECORD_ID)
    assert record.failure_count == 1
    assert record.consecutive_failures == 1
    assert len(ledger.data["contradictions"]) == 1


def test_a_second_contradiction_in_one_run_does_not_double_charge(
    portal, store, seeded
):
    """One execution's opinion is one opinion, however many times it says it."""
    run = open_run(store, "exec-single-opinion", portal.url)
    for _ in range(3):
        run.contradicted(
            STALE_RECORD_ID,
            field="expected_result",
            believed="the site-visit list is on screen",
            observed={"ok": False},
            reason="did not verify",
        )
    run.close(note="test")
    record = record_of(store, STALE_RECORD_ID)
    assert record.consecutive_failures == 1, (
        "one execution repeating itself must not write a record off"
    )
    assert record.trust is TrustLevel.DEGRADED


def test_markers_reject_every_page_that_is_not_the_area():
    """The check has to be strong enough that a positive verdict means something."""
    blank = marker_module.Observation(url="/sales/documentation", text="")
    assert not marker_module.verify(blank).ok

    dashboard = marker_module.Observation(
        url="/sales/gm-dashboard",
        text="Sales Overview Contractor: Lippolis Electric, Inc.",
    )
    assert not marker_module.verify(dashboard).ok

    missing = marker_module.Observation(
        url="/sales/documentation",
        text="Not found. Nothing here.",
    )
    verdict = marker_module.verify(missing)
    assert not verdict.ok
    assert verdict.dead_route_phrase == "not found"

    # The word alone is not enough: the area's own labels and its table
    # headers both have to be there too.
    named_only = marker_module.Observation(
        url="/sales/documentation", text="Documentation",
    )
    assert not marker_module.verify(named_only).ok

    no_table = marker_module.Observation(
        url="/sales/documentation",
        text="Documentation / Documentation Library Document Library "
             "Choose timeframe Site Visits",
    )
    assert not marker_module.verify(no_table).ok, (
        "text alone must not verify an area whose proof is a list"
    )


@pytest.mark.parametrize("headers,expected", [
    ([["customer", "site name", "status"]], True),
    ([["customer"]], False),
    ([["name", "date"]], False),
])
def test_marker_table_requirement(headers, expected):
    observation = marker_module.Observation(
        url="/sales/documentation",
        text="Documentation Library Document Library Choose timeframe",
        table_headers=headers,
        table_row_counts=[4],
    )
    assert marker_module.verify(observation).ok is expected
