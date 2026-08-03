"""Proof 10: one contractor's knowledge is never spent on another's portal.

Two TEGG contractors see different menus, different sites and different
customers. A route learned inside Lippolis's workspace is not a fact about
TEGG, it is a fact about Lippolis, and applying it anywhere else is both wrong
and a data-boundary problem.

The boundary is enforced in three places and all three are checked here,
because any one of them alone would be a single point of failure: the document
refuses foreign records, the store refuses to hand a document to the wrong
tenant, and the operation refuses to run when it finds nothing it is allowed to
use.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

# The whole operation drives a real browser; skip rather than fail without one.
pytest.importorskip("playwright")

from awe_knowledge.models import TenantMismatch  # noqa: E402
from awe_knowledge.runtime import KnowledgeRun  # noqa: E402
from awe_tegg.checkpoint import ESCALATED  # noqa: E402
from awe_tegg.operation import PROCEDURE_RECORD_ID, STALE_RECORD_ID, start  # noqa: E402

from conftest import (  # noqa: E402
    ENVIRONMENT,
    INTEGRATION,
    TENANT,
    open_run,
    record_of,
    seed_stale_navigation,
)

OTHER = "sparrow-electric"


def test_a_run_cannot_see_another_tenants_records(store, portal, seeded):
    seed_stale_navigation(store, base_url=portal.url, tenant=OTHER)

    ours = open_run(store, "exec-ours", portal.url, tenant=TENANT)
    theirs = open_run(store, "exec-theirs", portal.url, tenant=OTHER)

    assert ours.usable(STALE_RECORD_ID) is not None
    assert theirs.usable(STALE_RECORD_ID) is not None
    assert ours.document is not theirs.document
    assert ours.document.tenant == TENANT
    assert theirs.document.tenant == OTHER


def test_a_document_refuses_a_record_belonging_to_someone_else(store, portal, seeded):
    seed_stale_navigation(store, base_url=portal.url, tenant=OTHER)
    ours = open_run(store, "exec-put", portal.url, tenant=TENANT)
    foreign = record_of(store, STALE_RECORD_ID, tenant=OTHER)

    with pytest.raises(TenantMismatch):
        ours.document.put(foreign)


def test_the_store_refuses_to_serve_a_document_to_the_wrong_tenant(
    store, portal, seeded, tmp_path
):
    """A mislabelled file on disk must not be readable as somebody else's."""
    ours = store.path_for(TENANT, INTEGRATION, ENVIRONMENT)
    theirs = store.directory_for(OTHER, INTEGRATION, ENVIRONMENT)
    theirs.mkdir(parents=True, exist_ok=True)
    (theirs / "knowledge.json").write_text(
        ours.read_text(encoding="utf-8"), encoding="utf-8"
    )

    with pytest.raises(TenantMismatch):
        store.load(OTHER, INTEGRATION, ENVIRONMENT)


def test_a_run_for_another_tenant_starts_from_nothing(store, portal, seeded):
    """No leak by omission: the other tenant gets an empty document, not ours."""
    other = open_run(store, "exec-other", portal.url, tenant=OTHER)
    assert other.document.records == {}
    assert other.usable(STALE_RECORD_ID) is None
    assert other.applicable() == []


def test_a_mislabelled_document_is_refused_rather_than_replaced(
    store, portal, seeded
):
    """The dangerous case: a file in one tenant's slot holding another's records.

    Starting a fresh document here would be worse than failing, because the
    run's own save would then overwrite the records that were sitting there.
    """
    theirs = store.directory_for(OTHER, INTEGRATION, ENVIRONMENT)
    theirs.mkdir(parents=True, exist_ok=True)
    (theirs / "knowledge.json").write_text(
        store.path_for(TENANT, INTEGRATION, ENVIRONMENT).read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    before = (theirs / "knowledge.json").read_text(encoding="utf-8")

    run = KnowledgeRun(
        store, OTHER, INTEGRATION, ENVIRONMENT, execution_id="exec-mislabelled"
    )
    with pytest.raises(TenantMismatch):
        run.open(base_url=portal.url)
    assert (theirs / "knowledge.json").read_text(encoding="utf-8") == before


def test_a_correction_learned_for_one_tenant_is_not_offered_to_another(
    portal, store, seeded, settings, credentials, tmp_path
):
    """The end-to-end version: repair Lippolis, then run as somebody else."""
    settings.store_root = store.root
    work = tmp_path / "work"

    repaired = start(settings, work_root=work, run_id="tenant-one")
    assert repaired.corrected_knowledge

    settings.tenant = OTHER
    other = start(settings, work_root=work, run_id="tenant-two")

    assert other.status == ESCALATED
    assert other.knowledge_used == []
    assert other.human_action_required
    assert "no usable navigation knowledge" in other.human_action_required[0]
    assert record_of(store, PROCEDURE_RECORD_ID, tenant=TENANT) is not None
    assert not store.exists(OTHER, INTEGRATION, ENVIRONMENT) or (
        record_of(store, PROCEDURE_RECORD_ID, tenant=OTHER) is None
    )
