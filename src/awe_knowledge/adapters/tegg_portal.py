"""Turning a TEGG portal run into knowledge, and back again.

The TEGG driver already writes an ``observations.json`` beside its
screenshots: one entry per step, each with a timestamp, an outcome from a
fixed taxonomy, the URL it was on, and a human detail string. That file is
the honest input to this layer -- it was written by the run, not by an agent
recalling the run afterwards.

So this module does two things:

  * ``ingest_observations`` reads one run's observations and records the
    outcome of each step against the matching knowledge record. Steps that
    succeeded count as successes; steps that failed degrade exactly the
    record they were about.
  * ``preflight_selectors`` checks stored selectors against a live page
    **without acting on them** -- it looks, it does not click, type or
    submit. That is what makes it safe to run against a customer's portal.

Nothing here imports Playwright at module level, so the knowledge layer and
its tests stay importable on a machine with no browser installed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Iterable

from ..models import RecordKind, TrustLevel
from ..runtime import KnowledgeRun

#: The tenant this adapter is bound to. Knowledge is never shared across
#: contractors: two TEGG contractors see different assets and different menus.
TENANT = "lippolis"
INTEGRATION = "tegg-pro"
ENVIRONMENT = "production"
BASE_URL = "https://tegg2.teggpro.com"

#: Driver step -> the record it is evidence about. A step with no entry here
#: is still worth keeping, so it lands as a generic observation instead.
STEP_RECORDS: dict[str, tuple[RecordKind, str]] = {
    "login_form": (RecordKind.AUTH, "portal-login-form"),
    "login_contractor": (RecordKind.AUTH, "contractor-selection"),
    "login_result": (RecordKind.AUTH, "portal-login"),
    "login": (RecordKind.AUTH, "portal-login"),
    "open_documentation": (RecordKind.NAVIGATION, "documentation-area"),
    "set_timeframe": (RecordKind.NAVIGATION, "visit-timeframe"),
    "list_site_visits": (RecordKind.NAVIGATION, "site-visit-list"),
    "list_pagination": (RecordKind.NAVIGATION, "site-visit-list-pagination"),
    "open_site_visit": (RecordKind.NAVIGATION, "open-site-visit"),
    "open_document_library": (RecordKind.NAVIGATION, "site-visit-documentation"),
    "discover_documents": (RecordKind.NAVIGATION, "site-visit-documents"),
    "inventory_actions": (RecordKind.NAVIGATION, "site-visit-actions"),
}

#: Outcomes the driver reports. Only the first means the step worked.
GOOD_OUTCOMES = ("confirmed_available",)

#: Steps that are a run measuring itself, not a fact about the portal. They
#: stay in the evidence file -- that is where a later run reads them to compare
#: two executions -- but they never become knowledge.
NON_KNOWLEDGE_STEPS = frozenset({"knowledge_login"})

# "password=label='Enter your password'  username=label='…'  submit=text='Sign in'"
_FIELD_DETAIL = re.compile(r"(\w+)=(label|text|css|role)='([^']*)'")


def execution_id_for(observations_path: Path | str) -> str:
    """A stable id for one run, taken from the run's own first timestamp.

    Two runs from the same evidence directory get the same id, which is what
    stops a single execution from voting twice towards VERIFIED.
    """
    path = Path(observations_path)
    entries = _read(path)
    stamp = entries[0].get("at", "") if entries else ""
    return f"{path.parent.name}@{stamp}" if stamp else path.parent.name


def _read(path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return raw if isinstance(raw, list) else []


def generalize_url(url: str) -> str:
    """A URL with its record ids replaced by placeholders.

    A landed URL like ``/work/3075/968/5033/0`` identifies one customer's
    site visit. The reusable fact is the *shape* of the route, so the shape
    is what the store keeps -- in the payload and in the evidence alike.
    """
    return re.sub(r"/\d+", "/<id>", (url or "").split("?")[0])


def payload_for(step: str, entry: dict[str, Any]) -> dict[str, Any]:
    """The durable facts in one observation, minus anything run-specific.

    A count of site visits or a millisecond timing belongs in the evidence,
    not in the knowledge: it changes every run and would make every run look
    like a contradiction.
    """
    detail = str(entry.get("detail", ""))
    url = generalize_url(str(entry.get("url", "")))
    if step == "login_form":
        fields = {name: (how, what) for name, how, what in _FIELD_DETAIL.findall(detail)}
        payload: dict[str, Any] = {
            "login_url": url,
            "form_fields": sorted(fields),
        }
        for name, (how, what) in sorted(fields.items()):
            payload[f"{name}_locator"] = {"by": how, "value": what}
        if "required" in detail:
            payload["contractor_required"] = True
        return payload
    if step == "login_contractor":
        match = re.search(r"'([^']+)'\s*->\s*'([^']+)'", detail)
        return {
            "login_url": url,
            "control": "contractorconnection",
            "configured_value": match.group(1) if match else "",
            "resolves_to": match.group(2) if match else "",
        }
    if step in ("login_result", "login"):
        data = entry.get("data") or {}
        payload = {
            "login_url": f"{BASE_URL}/auth/login",
            "authenticated_url": url,
            "authenticated_indicator": "the sign-in form is gone",
        }
        # Only the ``login_result`` step carries the network trace. Claiming
        # an empty API list from the steps that do not would read as a
        # contradiction of perfectly good knowledge.
        if "responses" in data:
            payload["auth_api"] = sorted(
                {
                    r.get("url", "")
                    for r in data["responses"]
                    if r.get("status") == 200
                }
            )
        if "new_cookies" in data:
            payload["sets_new_cookies"] = bool(data["new_cookies"])
        return payload
    if step == "open_documentation":
        return {
            "starting_state": "signed in, on the dashboard",
            "actions": ["open the Documentation area"],
            "expected_result": "the site-visit list is on screen",
            "url": url,
        }
    if step == "set_timeframe":
        match = re.search(r"'([^']+)'", detail)
        return {
            "starting_state": "the Documentation area is open",
            "actions": [f"set the timeframe to {match.group(1) if match else '?'}"],
            "expected_result": "the list covers every site visit, not just recent ones",
            "url": url,
        }
    if step in ("list_site_visits", "list_pagination"):
        return {
            "starting_state": "the Documentation area is open with a timeframe set",
            "actions": ["read every page of the visit table"],
            "expected_result": "one row per completed site visit",
            "url": url,
        }
    if step == "open_site_visit":
        return {
            "starting_state": "a row in the site-visit list",
            "actions": [
                "click the row, which hands off to remote.teggpro.com via /auth/gsso/",
                "wait out the 'Redirecting...' page",
                "wait out 'Loading locations... / Loading assets...'",
                "confirm the landed URL carries the same trailing id path",
            ],
            "expected_result": "the remote work page for that visit",
            "context_check": "trailing-id-path",
            "url_pattern": url,
        }
    if step == "open_document_library":
        match = re.search(r"'([^']+)'", detail)
        return {
            "starting_state": "a site visit is open on remote.teggpro.com",
            "actions": [f"open {match.group(1) if match else 'the documents area'}"],
            "expected_result": "the document list for that visit",
            "label_used": match.group(1) if match else "",
            "url": url,
        }
    return {
        "starting_state": "",
        "actions": [detail] if detail else [],
        "expected_result": detail,
        "url": url,
    }


def ingest_observations(
    run: KnowledgeRun,
    observations_path: Path | str,
    *,
    artifacts_note: str = "",
) -> list[str]:
    """Record one run's observations against the knowledge document.

    Returns the record ids touched. A step whose outcome is not
    ``confirmed_available`` is recorded as a failure against its own record
    and nothing else -- one bad step never demotes a whole portal.
    """
    path = Path(observations_path)
    # Screenshots and page captures stay where the driver put them: they name
    # customers and the login, so they are not committed with the knowledge.
    # The record points at them instead of carrying them.
    where = artifacts_note or f"evidence kept locally under {path.parent}"
    touched: list[str] = []
    for entry in _read(path):
        step = str(entry.get("step", ""))
        if step in NON_KNOWLEDGE_STEPS:
            continue
        kind, name = STEP_RECORDS.get(step, (RecordKind.NAVIGATION, step or "unknown"))
        payload = payload_for(step, entry)
        record = run.observe(
            kind, name, payload,
            note=f"observed by the TEGG driver at step {step!r}; {where}",
        )
        touched.append(record.record_id)
        touched.extend(_ingest_selectors(run, step, entry))
        if entry.get("outcome") in GOOD_OUTCOMES:
            run.succeeded(
                record.record_id,
                url=generalize_url(str(entry.get("url", ""))),
                note=str(entry.get("detail", "")),
                observed_at=str(entry.get("at", "")),
            )
        else:
            run.failed(
                record.record_id,
                f"{entry.get('outcome', 'unknown outcome')}: {entry.get('detail', '')}",
            )
    return touched


#: What each login control is *for*. The name of the control is safe to
#: store; what gets typed into it never is.
LOGIN_FIELD_PURPOSE = {
    "username": "the account name field on the sign-in form",
    "password": "the password field on the sign-in form",
    "submit": "the button that submits the sign-in form",
    "contractor": "the contractor picker the form requires before sign-in",
}


def _ingest_selectors(
    run: KnowledgeRun, step: str, entry: dict[str, Any]
) -> list[str]:
    """Break a login-form observation into one record per control.

    Kept separate from the form record because controls fail one at a time:
    the password field moving should degrade the password selector and leave
    the rest of the form's knowledge alone.
    """
    if step != "login_form":
        return []
    touched: list[str] = []
    detail = str(entry.get("detail", ""))
    for name, how, what in _FIELD_DETAIL.findall(detail):
        record = run.observe(
            RecordKind.SELECTOR,
            f"login.{name}",
            {
                "component": "sign-in form",
                "purpose": LOGIN_FIELD_PURPOSE.get(name, f"the {name} control"),
                "preferred": {"by": how, "value": what},
                "selector_type": how,
                "fallbacks": [],
                "page": str(entry.get("url", "")),
            },
            note=f"seen on the sign-in form at step {step!r}",
        )
        touched.append(record.record_id)
        if entry.get("outcome") in GOOD_OUTCOMES:
            run.succeeded(record.record_id, url=generalize_url(str(entry.get("url", ""))),
                          observed_at=str(entry.get("at", "")))
        else:
            run.failed(record.record_id, str(entry.get("outcome", "not found")))
    return touched


# -- live, read-only preflight -------------------------------------------
def locator_from(payload: dict[str, Any], page: Any) -> Any:
    """A Playwright locator for a stored selector payload, or None.

    Understands the three ways this codebase names a control -- by label, by
    visible text, by CSS -- because that is what the driver already records.
    """
    from tegg import portal as tegg_portal          # imported late, on purpose

    preferred = payload.get("preferred") or {}
    by = str(preferred.get("by", "css"))
    value = str(preferred.get("value", ""))
    if not value:
        return None
    if by == "label":
        return tegg_portal.find_field(page, value)
    if by == "text":
        return tegg_portal.find_button(page, value)
    if by == "role-link":
        return tegg_portal.find_link(page, value)
    return page.locator(value).first


def preflight_selectors(
    run: KnowledgeRun,
    page: Any,
    record_ids: Iterable[str],
    *,
    artifacts: Iterable[Path | str] = (),
) -> dict[str, bool]:
    """Look for each stored selector on the current page. Never act on one.

    This is the cheap check that decides whether a run can proceed on stored
    knowledge or has to rediscover. It is deliberately read-only: a preflight
    that clicked things would be a change to a customer's portal.
    """
    results: dict[str, bool] = {}
    for record_id in record_ids:
        record = run.usable(record_id)
        if record is None:
            results[record_id] = False
            continue

        def attempt(payload: dict[str, Any], _page: Any = page) -> bool:
            locator = locator_from(payload, _page)
            return bool(locator is not None and locator.count() > 0)

        outcome = run.resolve(record_id, attempt=attempt, artifacts=artifacts)
        results[record_id] = outcome.ok
    return results


def open_run(
    store: Any,
    *,
    execution_id: str,
    clock: Callable[[], str] | None = None,
    allow_candidate: bool = False,
    artifact_root: Path | str | None = None,
) -> KnowledgeRun:
    """A knowledge run bound to the TEGG Lippolis production tenant."""
    kwargs: dict[str, Any] = {
        "execution_id": execution_id,
        "allow_candidate": allow_candidate,
        "artifact_root": artifact_root,
    }
    if clock is not None:
        kwargs["clock"] = clock
    return KnowledgeRun(store, TENANT, INTEGRATION, ENVIRONMENT, **kwargs)


def usable_summary(run: KnowledgeRun) -> dict[str, list[str]]:
    """What this tenant currently knows, grouped by how far it is trusted."""
    summary: dict[str, list[str]] = {level.value: [] for level in TrustLevel}
    if run.document is None:
        return summary
    for record in sorted(run.document.records.values(), key=lambda r: r.record_id):
        summary[record.trust.value].append(record.record_id)
    return summary
