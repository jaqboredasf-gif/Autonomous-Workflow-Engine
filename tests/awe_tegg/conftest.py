"""Scaffolding for the operation tests.

Every test here runs against a private knowledge store in ``tmp_path`` and a
mock portal on a loopback port. Two consequences worth stating:

  * no test can reach the live portal, and none needs a real credential -- the
    mock's own username and password are set into the environment for the
    duration of a test and removed afterwards;
  * the knowledge store is seeded with exactly the record the live store holds
    (``navigation:documentation-area``, VERIFIED by two distinct executions,
    carrying a sentence and no markers), so the tests exercise the real
    starting condition rather than a convenient one.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from awe_knowledge.models import (  # noqa: E402
    EvidenceRef,
    KnowledgeRecord,
    RecordKind,
    TrustLevel,
)
from awe_knowledge.runtime import KnowledgeRun  # noqa: E402
from awe_knowledge.store import KnowledgeStore  # noqa: E402
from awe_tegg.operation import STALE_RECORD_ID, Settings  # noqa: E402

TENANT = "lippolis"
INTEGRATION = "tegg-pro"
ENVIRONMENT = "production"

#: The payload the live store really holds for this record, copied from
#: ``data/operational_knowledge/lippolis/tegg-pro/production/knowledge.json``.
#: A sentence for an expected result, no markers, no settle step.
STALE_PAYLOAD = {
    "starting_state": "signed in, on the dashboard",
    "actions": ["open the Documentation area"],
    "expected_result": "the site-visit list is on screen",
    "url": "https://tegg2.teggpro.com/sales/documentation",
}


class FixedClock:
    def __init__(self, start: str = "2026-07-31T12:00:00+00:00") -> None:
        self.now = start

    def __call__(self) -> str:
        return self.now

    def set(self, iso: str) -> None:
        self.now = iso


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock()


@pytest.fixture
def store(tmp_path: Path) -> KnowledgeStore:
    return KnowledgeStore(tmp_path / "operational_knowledge")


@pytest.fixture
def portal():
    from mock_documentation import MockDocumentationPortal

    with MockDocumentationPortal(render_delay_ms=1200) as server:
        yield server


@pytest.fixture
def browser():
    playwright_module = pytest.importorskip("playwright")  # noqa: F841
    from playwright.sync_api import sync_playwright

    from tegg.browser import launch

    with sync_playwright() as playwright:
        instance = launch(playwright, headless=True)
        yield instance
        instance.close()


@pytest.fixture
def credentials(monkeypatch):
    """The mock portal's credentials, present only while a test runs."""
    from mock_documentation import PASSWORD, USERNAME

    monkeypatch.setenv("TEGG_USERNAME", USERNAME)
    monkeypatch.setenv("TEGG_PASSWORD", PASSWORD)
    return USERNAME, PASSWORD


@pytest.fixture
def settings(portal, tmp_path) -> Settings:
    from mock_documentation import WORKSPACE

    return Settings(
        base_url=portal.url,
        tenant=TENANT,
        integration=INTEGRATION,
        environment=ENVIRONMENT,
        contractor=WORKSPACE.split(",")[0],      # "Lippolis Electric"
        login_timeout_ms=15000,
        timeout_ms=15000,
        settle_budget_ms=8000,
        discovery_seconds=60.0,
        headless=True,
    )


def seed_stale_navigation(
    store: KnowledgeStore,
    *,
    base_url: str,
    tenant: str = TENANT,
    trust: TrustLevel = TrustLevel.VERIFIED,
    at: str = "2026-07-31T00:00:00+00:00",
) -> KnowledgeRecord:
    """Put the store in the state the live one is actually in.

    VERIFIED, vouched for by two distinct executions, and pointing at a URL on
    the portal under test so the record is applicable rather than merely
    present.
    """
    document = store.load_or_create(tenant, INTEGRATION, ENVIRONMENT,
                                    base_url=base_url)
    payload = dict(STALE_PAYLOAD)
    payload["url"] = base_url.rstrip("/") + "/sales/documentation"
    record = KnowledgeRecord(
        record_id=STALE_RECORD_ID,
        kind=RecordKind.NAVIGATION,
        name="documentation-area",
        tenant=tenant,
        integration=INTEGRATION,
        environment=ENVIRONMENT,
        payload=payload,
        trust=trust,
        version=5,
        success_count=3,
        verified_by_runs=["evidence-list@2026-07-30T18:46:54+00:00",
                          "exploration@2026-07-30T18:56:15+00:00"],
        evidence=[
            EvidenceRef(execution_id="evidence-list@2026-07-30T18:46:54+00:00",
                        observed_at="2026-07-30T18:46:54+00:00", kind="run"),
            EvidenceRef(execution_id="exploration@2026-07-30T18:56:15+00:00",
                        observed_at="2026-07-30T18:56:15+00:00", kind="run"),
        ],
        created_at=at,
        updated_at=at,
        last_success=at,
        last_verified=at,
    )
    document.put(record)
    store.save(document, at=at, execution_id="seed", note="seeded for a test")
    return record


@pytest.fixture
def seeded(store, portal):
    """A store holding the stale navigation record, as production does."""
    return seed_stale_navigation(store, base_url=portal.url)


def open_run(store: KnowledgeStore, execution_id: str, base_url: str,
             *, tenant: str = TENANT, artifact_root: Path | None = None,
             allow_candidate: bool = True) -> KnowledgeRun:
    run = KnowledgeRun(
        store, tenant, INTEGRATION, ENVIRONMENT,
        execution_id=execution_id,
        allow_candidate=allow_candidate,
        artifact_root=artifact_root,
    )
    run.open(base_url=base_url)
    return run


def trust_of(store: KnowledgeStore, record_id: str, tenant: str = TENANT) -> str:
    document = store.load(tenant, INTEGRATION, ENVIRONMENT)
    record = document.get(record_id)
    assert record is not None, f"{record_id} is not in the store"
    return record.trust.value


def record_of(store: KnowledgeStore, record_id: str, tenant: str = TENANT):
    return store.load(tenant, INTEGRATION, ENVIRONMENT).get(record_id)
