"""The closed loop, without a browser.

The behaviour these pin down is the whole point of the layer:

  * a later run *uses* what an earlier run verified, instead of exploring
  * when one piece of knowledge fails, exactly one piece is repaired
  * a repaired piece is reused on the next run
  * two runs of the same script against the same store, with the same clock,
    produce the same file
"""

from __future__ import annotations

import json

from awe_knowledge import KnowledgeRun, RecordKind, TrustLevel
from conftest import ENVIRONMENT, INTEGRATION, TENANT

SELECTOR = "selector:login.username"
PASSWORD_SELECTOR = "selector:login.password"


def _run(store, clock, execution_id, **kwargs) -> KnowledgeRun:
    return KnowledgeRun(store, TENANT, INTEGRATION, ENVIRONMENT,
                        execution_id=execution_id, clock=clock, **kwargs)


def _selector_payload(value: str = "Username") -> dict:
    return {
        "component": "sign-in form",
        "purpose": "the account name field",
        "preferred": {"by": "label", "value": value},
        "selector_type": "label",
        "fallbacks": [],
    }


def _teach(store, clock, *, value: str = "Username", executions=("run-1", "run-2")):
    """Get one selector to VERIFIED the only way that is allowed: by working."""
    for execution_id in executions:
        run = _run(store, clock, execution_id)
        run.open()
        run.resolve(
            SELECTOR,
            attempt=lambda payload: payload["preferred"]["value"] == value,
            discover=lambda: _selector_payload(value),
            kind=RecordKind.SELECTOR, name="login.username",
        )
        run.close(note=f"teaching from {execution_id}")


# -- retrieval and reuse --------------------------------------------------
def test_a_first_run_discovers_and_does_not_trust_itself(store, clock):
    run = _run(store, clock, "run-1")
    run.open()
    outcome = run.resolve(SELECTOR, attempt=lambda p: True,
                          discover=_selector_payload,
                          kind=RecordKind.SELECTOR, name="login.username")
    run.close()

    assert outcome.ok and outcome.rediscovered
    assert run.get(SELECTOR).trust is TrustLevel.CANDIDATE
    assert run.usable(SELECTOR) is None          # not usable unattended yet


def test_a_later_run_uses_verified_knowledge_without_exploring(store, clock):
    _teach(store, clock)

    explored = []
    run = _run(store, clock, "run-3")
    run.open()
    outcome = run.resolve(
        SELECTOR,
        attempt=lambda payload: payload["preferred"]["value"] == "Username",
        discover=lambda: explored.append("explored") or _selector_payload(),
    )
    report = run.close()

    assert outcome.ok and outcome.source == "verified" and not outcome.rediscovered
    assert explored == []                        # nothing was rediscovered
    assert report.used == [SELECTOR]
    assert report.rediscovered == []


def test_a_run_may_be_told_to_accept_hypotheses(store, clock):
    run = _run(store, clock, "run-1")
    run.open()
    run.resolve(SELECTOR, attempt=lambda p: True, discover=_selector_payload,
                kind=RecordKind.SELECTOR, name="login.username")
    run.close()

    strict = _run(store, clock, "run-2")
    strict.open()
    assert strict.usable(SELECTOR) is None

    lenient = _run(store, clock, "run-3", allow_candidate=True)
    lenient.open()
    assert lenient.usable(SELECTOR) is not None


# -- isolated repair ------------------------------------------------------
def test_one_failing_selector_does_not_cost_the_rest_of_the_portal(store, clock):
    """The failure a whole run used to die on now costs exactly one record."""
    for execution_id in ("run-1", "run-2"):
        run = _run(store, clock, execution_id)
        run.open()
        for record_id, name in ((SELECTOR, "login.username"),
                                (PASSWORD_SELECTOR, "login.password")):
            run.resolve(record_id, attempt=lambda p: True,
                        discover=_selector_payload,
                        kind=RecordKind.SELECTOR, name=name)
        run.close()

    run = _run(store, clock, "run-3")
    run.open()
    # The username field moved; the password field did not.
    outcome = run.resolve(
        SELECTOR,
        attempt=lambda payload: payload["preferred"]["value"] == "Email or username",
        discover=lambda: _selector_payload("Email or username"),
    )
    untouched = run.resolve(PASSWORD_SELECTOR, attempt=lambda p: True)
    report = run.close()

    assert outcome.ok and outcome.rediscovered
    assert run.get(SELECTOR).payload["preferred"]["value"] == "Email or username"
    assert untouched.ok and untouched.source == "verified"
    assert run.get(PASSWORD_SELECTOR).trust is TrustLevel.VERIFIED
    assert report.rediscovered == [SELECTOR]


def test_a_repaired_selector_is_reused_by_the_next_run(store, clock):
    _teach(store, clock)
    repair = _run(store, clock, "run-3")
    repair.open()
    repair.resolve(
        SELECTOR,
        attempt=lambda payload: payload["preferred"]["value"] == "Email or username",
        discover=lambda: _selector_payload("Email or username"),
    )
    repair.close()

    explored = []
    later = _run(store, clock, "run-4", allow_candidate=True)
    later.open()
    outcome = later.resolve(
        SELECTOR,
        attempt=lambda payload: payload["preferred"]["value"] == "Email or username",
        discover=lambda: explored.append("x") or _selector_payload(),
    )
    later.close()

    assert outcome.ok and not outcome.rediscovered
    assert explored == []


def test_a_rediscovery_that_contradicts_verified_knowledge_is_held(store, clock):
    """A repair only happens after the stored value actually failed."""
    _teach(store, clock)
    run = _run(store, clock, "run-3")
    run.open()
    # Fails against the stored value, and the discovered value also fails --
    # so the run does not get to quietly replace verified knowledge.
    outcome = run.resolve(
        SELECTOR,
        attempt=lambda payload: False,
        discover=lambda: _selector_payload("Something else"),
    )
    run.close()

    assert not outcome.ok
    assert run.get(SELECTOR).trust is TrustLevel.DEGRADED


def test_a_failing_attempt_that_raises_is_a_failure_not_a_crash(store, clock):
    _teach(store, clock)
    run = _run(store, clock, "run-3")

    def explode(payload):
        raise TimeoutError("locator never resolved")

    run.open()
    outcome = run.resolve(SELECTOR, attempt=explode)
    run.close()

    assert not outcome.ok
    assert run.get(SELECTOR).trust is TrustLevel.DEGRADED
    assert "TimeoutError" in json.dumps(run.report.to_dict())


def test_knowledge_with_nothing_stored_and_no_way_to_look_reports_absent(store, clock):
    run = _run(store, clock, "run-1")
    run.open()
    outcome = run.resolve("selector:nothing.here", attempt=lambda p: True)
    assert not outcome.ok and outcome.source == "absent"


# -- staleness, expiry, tenant -------------------------------------------
def test_stale_verified_knowledge_is_not_used_unattended(store, clock):
    _teach(store, clock)
    clock.set("2026-06-01T00:00:00+00:00")            # five months later
    run = _run(store, clock, "run-9")
    run.open()
    assert run.usable(SELECTOR) is None
    assert SELECTOR in run.report.stale


def test_a_run_cannot_open_another_tenants_document(store, clock, make_record):
    _teach(store, clock)
    other = KnowledgeRun(store, "other-contractor", INTEGRATION, ENVIRONMENT,
                         execution_id="run-x", clock=clock)
    other.open()
    assert other.document.records == {}                # empty, never the neighbour's


def test_expiry_is_applied_when_the_document_is_opened(store, clock):
    _teach(store, clock)
    setup = _run(store, clock, "run-3")
    setup.open()
    setup.get(SELECTOR).expires_at = "2026-01-05T00:00:00+00:00"
    setup.close()

    clock.set("2026-01-10T00:00:00+00:00")
    run = _run(store, clock, "run-4")
    run.open()
    assert run.get(SELECTOR).trust is TrustLevel.CANDIDATE
    assert run.report.expired == [SELECTOR]


# -- reporting and replay -------------------------------------------------
def test_the_run_reports_what_it_learned(store, clock):
    run = _run(store, clock, "run-1")
    run.open()
    run.resolve(SELECTOR, attempt=lambda p: True, discover=_selector_payload,
                kind=RecordKind.SELECTOR, name="login.username")
    report = run.close(note="first pass")

    assert report.learned_anything
    assert report.execution_id == "run-1"
    assert report.saved_to.endswith("knowledge.json")
    assert report.note == "first pass"
    assert json.loads(json.dumps(report.to_dict()))["changes"]


def test_two_identical_replays_produce_identical_knowledge(tmp_path, clock):
    """Same script, same clock, same bytes -- so a diff means a real change."""
    from awe_knowledge import KnowledgeStore

    written = []
    for index in (0, 1):
        store = KnowledgeStore(tmp_path / f"replay-{index}")
        clock.set("2026-01-01T00:00:00+00:00")
        for execution_id in ("run-1", "run-2"):
            run = _run(store, clock, execution_id)
            run.open()
            run.resolve(SELECTOR, attempt=lambda p: True, discover=_selector_payload,
                        kind=RecordKind.SELECTOR, name="login.username")
            run.close(note="replay")
        written.append(
            store.path_for(TENANT, INTEGRATION, ENVIRONMENT).read_text(encoding="utf-8")
        )
    assert written[0] == written[1]


def test_a_malformed_stored_document_stops_the_run(store, clock, make_record):
    _teach(store, clock)
    path = store.path_for(TENANT, INTEGRATION, ENVIRONMENT)
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["records"][SELECTOR]["payload"].pop("preferred")
    path.write_text(json.dumps(raw), encoding="utf-8")

    from awe_knowledge import KnowledgeError
    import pytest

    run = _run(store, clock, "run-9")
    with pytest.raises(KnowledgeError):
        run.open()


def test_an_observation_is_written_down_at_discovered(store, clock):
    run = _run(store, clock, "run-1")
    run.open()
    record = run.observe(
        RecordKind.FAILURE, "wrong-context-after-sso",
        {
            "observed_error": "opened a page that does not appear to be the visit",
            "likely_cause": "the SSO interstitial had not settled",
            "repair": "wait out 'Redirecting...' then compare the trailing id path",
        },
        note="seen live",
    )
    run.close()

    assert record.trust is TrustLevel.DISCOVERED
    assert run.usable(record.record_id) is None
