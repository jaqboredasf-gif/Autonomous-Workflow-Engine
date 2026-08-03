"""Proof 3 and 12: discovery cannot act, cannot wander, and cannot pretend.

Three separate claims, because they fail in three different ways:

  * it is read-only **by construction**, not by convention;
  * it stays inside its host, its action count and its clock;
  * when it cannot find the area it says so and escalates, rather than
    returning the least-bad route it saw.

The strongest of these is checked from the portal's side. The mock records
every non-login POST, PUT and DELETE it receives, and a run that finishes with
that list empty did not change anything -- whatever the client believed it was
doing.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

from awe_tegg import discovery as discovery_module  # noqa: E402
from awe_tegg import markers as marker_module  # noqa: E402
from awe_tegg.guard import (  # noqa: E402
    MUTATING_METHODS,
    MUTATING_TOKENS,
    PROBES,
    Budget,
    BudgetExhausted,
    MutationRefused,
    OffDomain,
    ReadOnlyPage,
    UnknownProbe,
)


class _SpyPage:
    """A page that records what was asked of it and never does anything."""

    def __init__(self, url: str = "http://127.0.0.1/start") -> None:
        self.url = url
        self.calls: list[str] = []

    def goto(self, url, **kwargs):
        self.calls.append(f"goto {url}")
        self.url = url

    def inner_text(self, _selector):
        return "some text"

    def evaluate(self, _script):
        return []

    def wait_for_timeout(self, _ms):
        self.calls.append("wait")

    @property
    def frames(self):
        return []


# -- read-only by construction -------------------------------------------
@pytest.mark.parametrize("method", sorted(MUTATING_METHODS))
def test_every_mutating_verb_is_refused(method):
    page = ReadOnlyPage(_SpyPage(), Budget(allowed_hosts=("127.0.0.1",)))
    with pytest.raises(MutationRefused) as raised:
        getattr(page, method)
    assert method in str(raised.value)


def test_an_unknown_attribute_is_refused_rather_than_forwarded():
    """The wrapper must not become a pass-through the day someone adds a verb."""
    page = ReadOnlyPage(_SpyPage(), Budget(allowed_hosts=("127.0.0.1",)))
    with pytest.raises(MutationRefused):
        page.some_new_playwright_method                     # noqa: B018


def test_the_probe_catalogue_contains_nothing_that_could_change_a_page():
    offenders = [
        (name, token)
        for name, script in PROBES.items()
        for token in MUTATING_TOKENS
        if token in script
    ]
    assert offenders == [], f"a probe could mutate the page: {offenders}"


def test_arbitrary_javascript_cannot_be_run():
    page = ReadOnlyPage(_SpyPage(), Budget(allowed_hosts=("127.0.0.1",)))
    with pytest.raises(UnknownProbe):
        page.probe("() => document.forms[0].submit()")
    with pytest.raises(MutationRefused):
        page.evaluate                                       # noqa: B018


# -- bounded --------------------------------------------------------------
def test_navigation_off_the_allowed_host_is_refused():
    page = ReadOnlyPage(_SpyPage(), Budget(allowed_hosts=("tegg2.teggpro.com",)))
    with pytest.raises(OffDomain):
        page.goto("https://example.com/sales/documentation")
    with pytest.raises(OffDomain):
        page.goto("https://remote.teggpro.com/work/1/2/3/0")


def test_the_action_budget_stops_discovery_and_says_so():
    spy = _SpyPage()
    budget = Budget(max_actions=2, allowed_hosts=("127.0.0.1",))
    page = ReadOnlyPage(spy, budget)
    page.goto("http://127.0.0.1/one")
    page.goto("http://127.0.0.1/two")
    with pytest.raises(BudgetExhausted) as raised:
        page.goto("http://127.0.0.1/three")
    assert "2 allowed action(s)" in str(raised.value)
    assert budget.trail == ["goto http://127.0.0.1/one", "goto http://127.0.0.1/two"]


def test_the_time_budget_stops_discovery():
    budget = Budget(max_actions=99, max_seconds=0.0, allowed_hosts=("127.0.0.1",))
    with pytest.raises(BudgetExhausted):
        ReadOnlyPage(_SpyPage(), budget).goto("http://127.0.0.1/anything")


def test_candidates_come_only_from_what_the_page_is_offering():
    """A remembered route is not a candidate. A live one is."""
    observation = marker_module.Observation(
        url="http://portal/sales/gm-dashboard",
        text="dashboard",
        links=[
            {"text": "", "href": "/sales/documentation",
             "router": "/sales/documentation/", "label": ""},
            {"text": "Sign Out", "href": "/auth/login", "router": "", "label": ""},
            {"text": "Business", "href": "/sales/business", "router": "", "label": ""},
        ],
    )
    found = discovery_module.candidates_from(observation, "http://portal")
    urls = [c.url for c in found]
    assert "http://portal/sales/documentation" in urls
    assert "http://portal/auth/login" not in urls, "sign-out must never be followed"
    assert "http://portal/sales/business" not in urls, (
        "a route with nothing to do with the area is not a candidate"
    )


def test_an_icon_only_link_is_still_found():
    """The live sidebar has no visible text on the anchor -- that broke the old
    fallback and must not break this one."""
    observation = marker_module.Observation(
        url="http://portal/sales/gm-dashboard",
        text="dashboard",
        links=[{"text": "", "href": "/sales/documentation",
                "router": "/sales/documentation/", "label": ""}],
    )
    found = discovery_module.candidates_from(observation, "http://portal")
    assert [c.url for c in found] == ["http://portal/sales/documentation"]


# -- live, against the mock ----------------------------------------------
def _read_only_page(browser, portal, **budget_kwargs):
    context = browser.new_context()
    page = context.new_page()
    budget = Budget(
        allowed_hosts=("127.0.0.1", "localhost"),
        **{"max_actions": 12, "max_seconds": 60.0, **budget_kwargs},
    )
    return context, ReadOnlyPage(page, budget)


def test_discovery_finds_a_relocated_area_and_changes_nothing(
    browser, portal, tmp_path
):
    portal.move_documentation("/sales/records-library")
    context, page = _read_only_page(browser, portal)
    try:
        page.goto(portal.url + "/sales/gm-dashboard")
        portal.forget_traffic()
        result = discovery_module.discover_documentation(
            page, base_url=portal.url, settle_budget_ms=8000,
            evidence_dir=tmp_path,
        )
    finally:
        context.close()

    assert result.ok
    assert result.route == "/sales/records-library"
    assert result.settle_ms >= 1000, (
        "the settle time is the fact the old record was missing"
    )
    assert result.verdict["ok"] is True
    assert portal.mutations == [], (
        f"discovery submitted something to the portal: {portal.mutations}"
    )


def test_discovery_escalates_when_the_area_is_gone(browser, portal, tmp_path):
    """Proof 12. No best guess, no fabricated success -- a named next action."""
    portal.hide_documentation()
    portal.move_documentation("/sales/nowhere")
    context, page = _read_only_page(browser, portal)
    try:
        page.goto(portal.url + "/sales/gm-dashboard")
        result = discovery_module.discover_documentation(
            page, base_url=portal.url, settle_budget_ms=3000,
            evidence_dir=tmp_path,
        )
    finally:
        context.close()

    assert not result.ok
    assert result.url == ""
    assert result.escalation, "an escalation must say what a person should do"
    assert "by hand" in result.escalation
    assert portal.mutations == []


def test_discovery_reports_what_it_dropped_when_the_budget_runs_out(
    browser, portal, tmp_path
):
    """A silent truncation reads as 'covered everything'. This one is loud."""
    portal.move_documentation("/sales/nowhere")
    context, page = _read_only_page(browser, portal, max_actions=1)
    try:
        page.goto(portal.url + "/sales/gm-dashboard")     # spends the one action
        result = discovery_module.discover_documentation(
            page, base_url=portal.url, settle_budget_ms=2000,
            evidence_dir=tmp_path,
        )
    finally:
        context.close()

    assert not result.ok
    assert "allowed action" in result.reason
    assert result.budget["spent_actions"] == 1
    assert result.escalation
