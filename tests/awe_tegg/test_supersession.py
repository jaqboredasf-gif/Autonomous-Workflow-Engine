"""Proof 4, 5 and 6: what it takes to replace a fact, and what replacing costs.

A replacement has to be worth more than the record it displaces, so three
things are required of it and checked here:

  * it may only be created from a route that **verified against page markers**
    -- a URL that looked plausible is not enough;
  * it carries the provenance of the live run that proved it, so a person
    reading the store six weeks from now can find the execution, the candidates
    it weighed and the evidence it kept;
  * the record it replaces is kept, marked, and linked in both directions.
    Deleting what we used to believe would destroy the only record of why we
    changed our minds.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

from awe_knowledge.models import KnowledgeError, RecordKind, TrustLevel  # noqa: E402
from awe_tegg import discovery as discovery_module  # noqa: E402
from awe_tegg.checkpoint import RunLedger  # noqa: E402
from awe_tegg.guard import Budget, ReadOnlyPage  # noqa: E402
from awe_tegg.operation import (  # noqa: E402
    PROCEDURE_KIND,
    PROCEDURE_NAME,
    PROCEDURE_RECORD_ID,
    STALE_RECORD_ID,
    build_replacement_payload,
    reach_documentation,
)

from conftest import TENANT, open_run, record_of  # noqa: E402


def _ledger(tmp_path: Path, portal, run_id: str = "test-run") -> RunLedger:
    return RunLedger.create(
        tmp_path / "work", run_id,
        operation="documentation-read", tenant=TENANT,
        integration="tegg-pro", environment="production",
        base_url=portal.url, credential_source="environment",
    )


def _page(browser):
    context = browser.new_context()
    return context, ReadOnlyPage(
        context.new_page(),
        Budget(max_actions=12, max_seconds=60.0,
               allowed_hosts=("127.0.0.1", "localhost")),
    )


def _repair(browser, portal, store, tmp_path, execution_id="exec-repair"):
    run = open_run(store, execution_id, portal.url, artifact_root=tmp_path)
    ledger = _ledger(tmp_path, portal, run_id=execution_id)
    context, page = _page(browser)
    try:
        applied = reach_documentation(
            run, page, ledger, base_url=portal.url,
            dashboard_url=portal.url + "/sales/gm-dashboard",
            settle_budget_ms=8000,
        )
    finally:
        context.close()
    report = run.close(note="repair")
    return applied, ledger, report


# -- proof 4 --------------------------------------------------------------
def test_a_replacement_is_only_created_from_a_marker_verified_route(
    browser, portal, store, seeded, tmp_path
):
    applied, ledger, _report = _repair(browser, portal, store, tmp_path)
    assert applied.ok
    assert applied.record_id == PROCEDURE_RECORD_ID

    record = record_of(store, PROCEDURE_RECORD_ID)
    verified_by = record.payload["provenance"]["verified_by_markers"]
    assert verified_by["ok"] is True
    assert verified_by["matched_headers"], "no table headers were actually matched"
    assert "documentation" in verified_by["matched_text"]


def test_no_replacement_is_written_when_nothing_verified(
    browser, portal, store, seeded, tmp_path
):
    """A route discovery could not prove must not become knowledge."""
    from awe_tegg.operation import Escalated

    portal.hide_documentation()
    portal.move_documentation("/sales/nowhere")
    run = open_run(store, "exec-nothing", portal.url)
    ledger = _ledger(tmp_path, portal, run_id="exec-nothing")
    context, page = _page(browser)
    try:
        with pytest.raises(Escalated):
            reach_documentation(
                run, page, ledger, base_url=portal.url,
                dashboard_url=portal.url + "/sales/gm-dashboard",
                settle_budget_ms=3000,
            )
    finally:
        context.close()
    run.close(note="nothing")

    assert record_of(store, PROCEDURE_RECORD_ID) is None
    assert ledger.data["human_action_required"]
    assert ledger.status == "escalated"


def test_a_malformed_replacement_is_refused(portal, store, seeded):
    """'Through the existing validation rules' has to bite, not just be said."""
    run = open_run(store, "exec-malformed", portal.url)
    with pytest.raises(KnowledgeError) as raised:
        run.replace(
            STALE_RECORD_ID,
            kind=RecordKind.PROCEDURE,
            name="documentation-read.broken",
            payload={"route": "/sales/documentation"},   # no 'steps'
            reason="test",
        )
    assert "missing 'steps'" in str(raised.value)
    assert record_of(store, STALE_RECORD_ID).trust is TrustLevel.VERIFIED, (
        "a refused replacement must not have superseded anything"
    )


# -- proof 5 --------------------------------------------------------------
def test_the_replacement_preserves_provenance_from_the_live_run(
    browser, portal, store, seeded, tmp_path
):
    _applied, _ledger_, _report = _repair(
        browser, portal, store, tmp_path, execution_id="exec-provenance"
    )
    record = record_of(store, PROCEDURE_RECORD_ID)
    provenance = record.payload["provenance"]

    assert provenance["execution_id"] == "exec-provenance"
    assert provenance["tenant"] == TENANT
    assert provenance["observed_at"]
    assert provenance["candidates_considered"], "the run must say what it weighed"
    assert any(c["verified"] for c in provenance["candidates_considered"])
    assert provenance["budget"]["spent_actions"] >= 1
    assert provenance["budget"]["allowed_hosts"]

    # The run's own evidence, not a claim about it.
    assert record.evidence, "a replacement with no evidence is an assertion"
    assert record.evidence[-1].execution_id == "exec-provenance"

    # And the facts that were missing from what it replaced.
    assert record.payload["observed_settle_ms"] >= 1000
    assert record.payload["markers"]["text_all_of"] == ["documentation"]
    assert [s["action"] for s in record.payload["steps"]] == [
        "goto", "settle", "verify"
    ]


def test_provenance_survives_a_round_trip_through_the_store(
    browser, portal, store, seeded, tmp_path
):
    """Provenance that only exists in memory is not provenance."""
    _repair(browser, portal, store, tmp_path, execution_id="exec-roundtrip")
    reopened = open_run(store, "exec-reader", portal.url)
    record = reopened.get(PROCEDURE_RECORD_ID)
    assert record.payload["provenance"]["execution_id"] == "exec-roundtrip"
    assert record.supersedes == STALE_RECORD_ID


# -- proof 6 --------------------------------------------------------------
def test_the_stale_record_is_superseded_not_deleted(
    browser, portal, store, seeded, tmp_path
):
    _repair(browser, portal, store, tmp_path, execution_id="exec-supersede")

    old = record_of(store, STALE_RECORD_ID)
    new = record_of(store, PROCEDURE_RECORD_ID)

    assert old is not None, "history was deleted instead of marked"
    assert old.trust is TrustLevel.INVALID
    assert old.superseded_by == PROCEDURE_RECORD_ID
    assert new.supersedes == STALE_RECORD_ID
    assert old.payload["url"].endswith("/sales/documentation"), (
        "what we used to believe must still be readable"
    )


def test_a_superseded_record_can_never_be_applied_again(
    browser, portal, store, seeded, tmp_path
):
    _repair(browser, portal, store, tmp_path, execution_id="exec-not-again")
    later = open_run(store, "exec-later", portal.url)
    assert later.usable(STALE_RECORD_ID) is None
    assert later.get(STALE_RECORD_ID) is not None


def test_the_replacement_starts_as_a_hypothesis(
    browser, portal, store, seeded, tmp_path
):
    """Superseding something is not a shortcut to being trusted."""
    _repair(browser, portal, store, tmp_path, execution_id="exec-hypothesis")
    record = record_of(store, PROCEDURE_RECORD_ID)
    assert record.trust is TrustLevel.CANDIDATE, (
        "one execution's discovery must not arrive VERIFIED"
    )
    assert len(record.verified_by_runs) == 1


def test_the_store_stays_valid_after_the_repair(
    browser, portal, store, seeded, tmp_path
):
    from awe_knowledge.validator import validate_document

    _repair(browser, portal, store, tmp_path, execution_id="exec-valid")
    document = store.load(TENANT, "tegg-pro", "production")
    report = validate_document(document)
    assert report.ok, report.problems


def test_the_payload_builder_names_what_it_supersedes(portal, store, seeded):
    run = open_run(store, "exec-payload", portal.url)
    result = discovery_module.DiscoveryResult(
        ok=True, url=portal.url + "/sales/documentation",
        route="/sales/documentation", settle_ms=1500,
        markers={"text_all_of": ["documentation"]},
        verdict={"ok": True}, candidates=[], budget={},
    )
    payload = build_replacement_payload(
        result, base_url=portal.url, run=run, supersedes=STALE_RECORD_ID
    )
    assert payload["supersedes"] == STALE_RECORD_ID
    assert payload["observed_settle_ms"] == 1500
    assert payload["settle_budget_ms"] > payload["observed_settle_ms"]
    assert PROCEDURE_KIND is RecordKind.PROCEDURE
    assert PROCEDURE_RECORD_ID.endswith(PROCEDURE_NAME)
