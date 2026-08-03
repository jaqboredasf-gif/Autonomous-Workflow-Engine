"""The closed loop, driven end to end against a real browser.

Every other test in this directory proves one segment. This one proves the
claim the whole layer exists to support: **a later execution is measurably
cheaper because of an earlier one, and stays correct when the portal changes
under it.**

Six executions, in order, each a real Playwright sign-in against a real HTTP
server:

===  ================================================================
 1   discovery. Nothing is known, so the form is probed and scored.
     Ingesting the run's own observations turns that into CANDIDATE
     knowledge -- one execution's word, not yet trusted.
 2   discovery again, because CANDIDATE is not usable unattended. The
     second distinct execution agreeing is what earns VERIFIED.
 3   **the payoff.** Stored selectors drive the sign-in. Zero probes.
 4   the portal is redesigned mid-loop: the username field is reworded.
     The stored value fails, that one record degrades, rediscovery
     repairs it, and the run still signs in.
 5   the repaired value is confirmed by a second distinct execution.
 6   zero probes again, on knowledge nobody wrote by hand.
===  ================================================================

The metric asserted is ``dom_probes`` -- full structural probes of the page --
rather than wall-clock, because it is the portal-dependent work and it does not
depend on the machine the test runs on.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

pytest.importorskip("playwright")

from mock_sitevisit import PASSWORD, USERNAME, MockSiteVisitPortal  # noqa: E402

from awe_knowledge.adapters import tegg_login, tegg_portal  # noqa: E402
from awe_knowledge.models import TrustLevel  # noqa: E402
from awe_knowledge.runtime import KnowledgeRun  # noqa: E402
from awe_knowledge.store import KnowledgeStore  # noqa: E402
from tegg import evidence, sitevisit  # noqa: E402
from tegg.browser import launch  # noqa: E402

# No login label hints on purpose. Config hints would be a second, hand-written
# memory of the portal, and this test is about the one the system earns.
SETTINGS = {
    "login_path": "/auth/login",
    "login_labels": {},
    "documentation_labels": ["Documentation"],
    "download_timeout_ms": 8000,
}

USERNAME_RECORD = tegg_login.CONTROL_RECORDS["username"]
PASSWORD_RECORD = tegg_login.CONTROL_RECORDS["password"]
SUBMIT_RECORD = tegg_login.CONTROL_RECORDS["submit"]


@pytest.fixture
def portal():
    with MockSiteVisitPortal() as server:
        yield server


@pytest.fixture
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        instance = launch(playwright, headless=True)
        yield instance
        instance.close()


class Execution:
    """One run's evidence directory, telemetry and knowledge report."""

    def __init__(self, name: str, telemetry, report, observations: Path) -> None:
        self.name = name
        self.telemetry = telemetry
        self.report = report
        self.observations = observations

    @property
    def probes(self) -> int:
        return self.telemetry.dom_probes

    def __repr__(self) -> str:                          # pragma: no cover
        return f"<{self.name}: {self.telemetry.describe()}>"


def sign_in(
    *,
    name: str,
    portal_server,
    browser,
    store: KnowledgeStore,
    work: Path,
    use_knowledge: bool,
) -> Execution:
    """One complete execution: sign in, record what it cost, persist what it learned."""
    evidence_dir = work / name
    recorder = evidence.Recorder(evidence_dir)
    run = None
    if use_knowledge:
        run = KnowledgeRun(
            store, tegg_portal.TENANT, tegg_portal.INTEGRATION,
            tegg_portal.ENVIRONMENT, execution_id=name, artifact_root=evidence_dir,
        )
        run.open(base_url=portal_server.url)

    context = browser.new_context()
    page = context.new_page()
    try:
        explorer = sitevisit.Explorer(
            page, portal_server.url, recorder, SETTINGS, knowledge=run
        )
        explorer.login(USERNAME, PASSWORD, None)
        assert "gm-dashboard" in page.url, "the run did not actually sign in"
    finally:
        context.close()

    telemetry = _telemetry_from(recorder)
    report = run.close(note=name) if run is not None else None
    return Execution(name, telemetry, report, recorder.flush())


def _telemetry_from(recorder: evidence.Recorder) -> tegg_login.LoginTelemetry:
    """Read the run's cost back out of its own evidence, not out of a variable.

    Going through the observations file is the point: it is what an operator
    or a later run has, so if the number is not in there it does not exist.
    """
    for observation in recorder.observations:
        if observation.step == sitevisit.KNOWLEDGE_STEP:
            return tegg_login.LoginTelemetry(**observation.data["knowledge"])
    raise AssertionError("the run recorded no sign-in telemetry")


def ingest(store: KnowledgeStore, execution: Execution, base_url: str) -> None:
    """Turn one finished run's evidence into knowledge, exactly as the CLI does."""
    run = KnowledgeRun(
        store, tegg_portal.TENANT, tegg_portal.INTEGRATION, tegg_portal.ENVIRONMENT,
        execution_id=f"ingest-{execution.name}",
    )
    run.open(base_url=base_url)
    tegg_portal.ingest_observations(run, execution.observations)
    run.close(note=f"ingest {execution.name}")


def trust_of(store: KnowledgeStore, record_id: str) -> TrustLevel:
    document = store.load_or_create(
        tegg_portal.TENANT, tegg_portal.INTEGRATION, tegg_portal.ENVIRONMENT
    )
    record = document.get(record_id)
    assert record is not None, f"{record_id} is not in the store"
    return record.trust


def successes(store: KnowledgeStore, record_id: str) -> int:
    document = store.load_or_create(
        tegg_portal.TENANT, tegg_portal.INTEGRATION, tegg_portal.ENVIRONMENT
    )
    return document.get(record_id).success_count


def test_a_later_execution_is_cheaper_because_of_an_earlier_one(
    portal, browser, tmp_path
):
    store = KnowledgeStore(tmp_path / "knowledge")
    work = tmp_path / "work"
    run_one = lambda name, knowledge: sign_in(          # noqa: E731
        name=name, portal_server=portal, browser=browser, store=store,
        work=work, use_knowledge=knowledge,
    )

    # -- 1. nothing is known -------------------------------------------
    first = run_one("exec-1-cold", False)
    assert first.telemetry.source == "discovery"
    assert first.probes == 1, "a cold run must pay for a structural probe"
    ingest(store, first, portal.url)

    assert trust_of(store, USERNAME_RECORD) is TrustLevel.CANDIDATE, (
        "one execution's word must not be usable unattended"
    )

    # -- 2. a second, distinct execution agrees -------------------------
    second = run_one("exec-2-cold", True)
    assert second.telemetry.source == "discovery", (
        "CANDIDATE knowledge must not be spent unattended"
    )
    assert second.probes == 1
    ingest(store, second, portal.url)

    for record_id in (USERNAME_RECORD, PASSWORD_RECORD, SUBMIT_RECORD):
        assert trust_of(store, record_id) is TrustLevel.VERIFIED, record_id

    # -- 3. the payoff --------------------------------------------------
    before_third = successes(store, USERNAME_RECORD)
    third = run_one("exec-3-knowing", True)
    assert third.telemetry.source == "knowledge"
    assert third.probes == 0, "a knowing run must not rediscover what it knows"
    assert third.probes < first.probes, "no measurable improvement"
    assert set(third.telemetry.used) == {
        USERNAME_RECORD, PASSWORD_RECORD, SUBMIT_RECORD
    }
    # Deliberately *not* asserted: that this is faster in milliseconds. Against
    # a local mock it is not -- one big page.evaluate beats three locator
    # round-trips when latency is zero. The structural probe is what stored
    # knowledge removes, and that is what is claimed here.

    # The run that *used* the knowledge is also the run that reinforced it.
    assert successes(store, USERNAME_RECORD) > before_third, (
        "using knowledge must count as evidence for it"
    )
    assert third.report.used, "the run's own report must name what it spent"

    # -- 4. the portal is redesigned under us ---------------------------
    portal.rename_username_field("Email or username")
    fourth = run_one("exec-4-drifted", True)

    assert fourth.telemetry.source == "knowledge+repair"
    assert fourth.probes == 1, "a repair costs exactly one probe, not one per control"
    assert USERNAME_RECORD in fourth.telemetry.rediscovered
    assert set(fourth.telemetry.used) == {PASSWORD_RECORD, SUBMIT_RECORD}, (
        "one control moving must not cost the others their trust"
    )
    assert trust_of(store, PASSWORD_RECORD) is TrustLevel.VERIFIED
    assert trust_of(store, SUBMIT_RECORD) is TrustLevel.VERIFIED
    assert trust_of(store, USERNAME_RECORD) is TrustLevel.CANDIDATE, (
        "a repaired record starts earning trust again from one execution"
    )

    document = store.load_or_create(
        tegg_portal.TENANT, tegg_portal.INTEGRATION, tegg_portal.ENVIRONMENT
    )
    assert document.get(USERNAME_RECORD).payload["preferred"]["value"] == (
        "Email or username"
    ), "the repair must be what is stored, not just what was used"

    degradation = [
        c for c in fourth.report.changes
        if c["record_id"] == USERNAME_RECORD and c["after"] == TrustLevel.DEGRADED.value
    ]
    assert degradation, "the correction must be visible in the run's own report"

    # -- 5. the repair is confirmed by a distinct execution -------------
    fifth = run_one("exec-5-confirming", True)
    assert fifth.probes == 1, "a CANDIDATE repair still has to be re-earned"
    assert trust_of(store, USERNAME_RECORD) is TrustLevel.VERIFIED

    # -- 6. back to free, on knowledge nobody typed ---------------------
    sixth = run_one("exec-6-knowing-again", True)
    assert sixth.telemetry.source == "knowledge"
    assert sixth.probes == 0, "the loop did not close: the system relearned nothing"
    assert set(sixth.telemetry.used) == {
        USERNAME_RECORD, PASSWORD_RECORD, SUBMIT_RECORD
    }


def test_telemetry_survives_a_round_trip_through_the_evidence_file(
    portal, browser, tmp_path
):
    """The cost of a run must be readable by a later one, not just in memory."""
    store = KnowledgeStore(tmp_path / "knowledge")
    execution = sign_in(
        name="exec-telemetry", portal_server=portal, browser=browser,
        store=store, work=tmp_path / "work", use_knowledge=True,
    )
    entries = json.loads(execution.observations.read_text(encoding="utf-8"))
    recorded = [e for e in entries if e["step"] == sitevisit.KNOWLEDGE_STEP]
    assert len(recorded) == 1
    assert recorded[0]["data"]["knowledge"]["dom_probes"] == execution.probes
    assert recorded[0]["data"]["knowledge"]["source"] == "discovery"


def test_telemetry_never_becomes_knowledge(portal, browser, tmp_path):
    """A run measuring itself is not a fact about the portal."""
    store = KnowledgeStore(tmp_path / "knowledge")
    execution = sign_in(
        name="exec-no-self-knowledge", portal_server=portal, browser=browser,
        store=store, work=tmp_path / "work", use_knowledge=False,
    )
    ingest(store, execution, portal.url)
    document = store.load_or_create(
        tegg_portal.TENANT, tegg_portal.INTEGRATION, tegg_portal.ENVIRONMENT
    )
    assert not [
        r for r in document.records if sitevisit.KNOWLEDGE_STEP in r
    ], "the run's own telemetry leaked into the knowledge store"


def test_the_step_name_is_the_same_on_both_sides():
    """Two modules that must agree, held together by a test rather than an import."""
    assert sitevisit.KNOWLEDGE_STEP == tegg_login.TELEMETRY_STEP
    assert tegg_login.TELEMETRY_STEP in tegg_portal.NON_KNOWLEDGE_STEPS
