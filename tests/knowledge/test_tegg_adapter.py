"""The TEGG adapter, driven by observation files instead of a browser.

The fixtures are the shape the live driver actually writes -- an
``observations.json`` with one entry per step -- with the portal's own
hostnames and identifiers replaced. Nothing here opens a page, and nothing
here needs a credential: that is the point of feeding knowledge from evidence
files rather than from a live session.
"""

from __future__ import annotations

from pathlib import Path

from awe_knowledge import KnowledgeStore, TrustLevel
from awe_knowledge.adapters import tegg_portal

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RUN_A = FIXTURES / "observations-run-a.json"
RUN_B = FIXTURES / "observations-run-b.json"

USERNAME_SELECTOR = "selector:login.username"
LIST_RECORD = "navigation:site-visit-list"


def _run(store, clock, execution_id, **kwargs):
    return tegg_portal.open_run(store, execution_id=execution_id, clock=clock,
                                **kwargs)


def test_one_run_of_observations_produces_hypotheses_not_facts(store, clock):
    run = _run(store, clock, "run-a")
    run.open()
    touched = tegg_portal.ingest_observations(run, RUN_A)
    run.close(note="first ingest")

    assert USERNAME_SELECTOR in touched
    assert run.get(USERNAME_SELECTOR).trust is TrustLevel.CANDIDATE
    assert run.usable(USERNAME_SELECTOR) is None       # not trusted on one run


def test_two_distinct_runs_agreeing_produce_verified_knowledge(store, clock):
    for execution_id, path in (("run-a", RUN_A), ("run-b", RUN_B)):
        run = _run(store, clock, execution_id)
        run.open()
        tegg_portal.ingest_observations(run, path)
        run.close()

    check = _run(store, clock, "run-c")
    check.open()
    assert check.get(USERNAME_SELECTOR).trust is TrustLevel.VERIFIED
    assert check.usable(USERNAME_SELECTOR) is not None


def test_a_step_that_failed_degrades_only_its_own_record(store, clock):
    """Run B's visit list came back empty. The login knowledge is unaffected."""
    for execution_id, path in (("run-a", RUN_A), ("run-b", RUN_B)):
        run = _run(store, clock, execution_id)
        run.open()
        tegg_portal.ingest_observations(run, path)
        run.close()

    check = _run(store, clock, "run-c")
    check.open()
    assert check.get(LIST_RECORD).trust is TrustLevel.DEGRADED
    assert check.get(USERNAME_SELECTOR).trust is TrustLevel.VERIFIED
    assert check.get("auth:portal-login").trust is TrustLevel.VERIFIED


def test_the_login_form_becomes_one_record_per_control(store, clock):
    run = _run(store, clock, "run-a")
    run.open()
    tegg_portal.ingest_observations(run, RUN_A)
    run.close()

    ids = sorted(r for r in run.document.records if r.startswith("selector:login."))
    # One record per control the driver reported a locator for. The contractor
    # picker is reported as a count of options, not as a locator, so it stays
    # in the auth record rather than being invented as a selector.
    assert ids == [
        "selector:login.password",
        "selector:login.submit",
        "selector:login.username",
    ]
    password = run.get("selector:login.password")
    assert password.payload["preferred"] == {"by": "label",
                                             "value": "Enter your password"}
    assert password.payload["selector_type"] == "label"

    contractor = run.get("auth:contractor-selection").payload
    assert contractor["control"] == "contractorconnection"
    assert contractor["configured_value"] == "Example"
    assert contractor["resolves_to"] == "ExamplePro Example"
    assert run.get("auth:portal-login-form").payload["contractor_required"] is True


def test_no_credential_reaches_the_store(store, clock, monkeypatch):
    """The store screens on save; this proves an ingest passes that screen."""
    monkeypatch.setenv("TEGG_USERNAME", "portal-user")
    monkeypatch.setenv("TEGG_PASSWORD", "portal-password")
    run = _run(store, clock, "run-a")
    run.open()
    tegg_portal.ingest_observations(run, RUN_A)
    path = Path(run.close().saved_to)

    text = path.read_text(encoding="utf-8")
    assert "portal-password" not in text
    assert "portal-user" not in text
    # What it keeps instead is where the fields are.
    assert "Enter your password" in text


def test_run_specific_detail_stays_out_of_the_knowledge(store, clock):
    """A visit count changes every run; storing it would fake a contradiction."""
    run = _run(store, clock, "run-a")
    run.open()
    tegg_portal.ingest_observations(run, RUN_A)
    run.close()

    payload = run.get(LIST_RECORD).payload
    assert "123" not in str(payload)
    assert payload["expected_result"] == "one row per completed site visit"


def test_the_same_evidence_directory_gives_the_same_execution_id():
    first = tegg_portal.execution_id_for(RUN_A)
    assert first == tegg_portal.execution_id_for(RUN_A)
    assert first != tegg_portal.execution_id_for(RUN_B)


def test_the_sso_handoff_knowledge_is_carried_as_navigation_steps(store, clock,
                                                                  tmp_path):
    """The interstitial and the id-path check are what a later run needs."""
    import json

    observations = json.loads(RUN_A.read_text(encoding="utf-8"))
    observations.append(
        {
            "at": "2026-01-02T09:01:00+00:00",
            "step": "open_site_visit",
            "outcome": "confirmed_available",
            "detail": "site visit T00-000 open",
            "url": "https://remote.example/work/1/2/3/0",
            "artifacts": [],
            "data": {},
        }
    )
    path = tmp_path / "observations.json"
    path.write_text(json.dumps(observations), encoding="utf-8")

    run = _run(store, clock, "run-a")
    run.open()
    tegg_portal.ingest_observations(run, path)
    run.close()

    payload = run.get("navigation:open-site-visit").payload
    assert payload["context_check"] == "trailing-id-path"
    assert any("Redirecting" in step for step in payload["actions"])


def test_the_adapter_is_bound_to_one_tenant(store, clock):
    run = _run(store, clock, "run-a")
    assert (run.tenant, run.integration, run.environment) == (
        "lippolis", "tegg-pro", "production",
    )


def test_a_second_ingest_of_the_same_run_does_not_count_twice(store, clock):
    run = _run(store, clock, "run-a")
    run.open()
    tegg_portal.ingest_observations(run, RUN_A)
    tegg_portal.ingest_observations(run, RUN_A)
    run.close()

    record = run.get(USERNAME_SELECTOR)
    assert record.trust is TrustLevel.CANDIDATE
    assert record.verified_by_runs == ["run-a"]


def test_the_store_keeps_tenants_apart_on_disk(tmp_path, clock):
    store = KnowledgeStore(tmp_path / "knowledge")
    run = _run(store, clock, "run-a")
    run.open()
    tegg_portal.ingest_observations(run, RUN_A)
    run.close()

    expected = store.path_for("lippolis", "tegg-pro", "production")
    assert expected.exists()
    assert "lippolis" in expected.parts
