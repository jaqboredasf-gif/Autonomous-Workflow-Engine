"""Signing in on what an earlier run already worked out.

This is the half of the loop that was missing. ``tegg_portal`` turns a finished
run into records; this module spends those records on the *next* run, and
measures what spending them saved.

The baseline it is measured against is the driver's own discovery path,
``tegg.login.locate``: one full multi-frame DOM probe, then a heuristic score
over every input on the page to work out which one is the username. That probe
is the cost. A run holding VERIFIED selectors should pay it zero times.

The order is the same one ``KnowledgeRun.resolve`` enforces everywhere else:

  1. try the stored locator,
  2. only if it no longer resolves, probe and rediscover,
  3. record which of those happened against that one control.

So a moved password field degrades ``selector:login.password`` and nothing
else, and the run still signs in.

Two refusals worth stating, because they are what make this safe to point at a
customer's portal:

  * **Nothing here types or clicks.** It resolves locators and counts what
    they match. Filling and submitting stay in ``tegg.sitevisit``, where they
    already were.
  * **A form this module cannot fully account for is handed back to
    discovery.** If the page carries a control the store knows nothing about
    -- a contractor picker that was not there yesterday -- the knowledge path
    declines rather than signing in with a form it has only partly understood.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any

from ..runtime import KnowledgeRun
from .tegg_portal import _FIELD_DETAIL, LOGIN_FIELD_PURPOSE, locator_from

#: The records one sign-in spends, and the ``LoginForm`` attribute each fills.
CONTROL_RECORDS: dict[str, str] = {
    "username": "selector:login.username",
    "password": "selector:login.password",
    "submit": "selector:login.submit",
}

#: The contractor picker is an AUTH record rather than a selector: what is
#: durable about it is that the control exists and what the configured value
#: resolves to, not a CSS path.
CONTRACTOR_RECORD = "auth:contractor-selection"

#: The step name the telemetry is recorded under. Deliberately not in
#: ``tegg_portal.STEP_RECORDS`` -- a run measuring itself is not a fact about
#: the portal, and must not become a record.
TELEMETRY_STEP = "knowledge_login"


@dataclass
class LoginTelemetry:
    """What locating the sign-in form cost, and how much of it was avoided.

    ``dom_probes`` is the honest number. It counts full-page structural probes
    (``tegg.login.probe``), which is the expensive, portal-dependent work.
    ``locate_ms`` is wall-clock and therefore noisier, kept because it is what
    an operator will actually notice.
    """

    #: knowledge | knowledge+repair | discovery
    source: str = "discovery"
    dom_probes: int = 0
    locate_ms: int = 0
    used: list[str] = field(default_factory=list)
    rediscovered: list[str] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def avoided_discovery(self) -> bool:
        return self.dom_probes == 0 and bool(self.used)

    def describe(self) -> str:
        return (
            f"{self.source}  probes={self.dom_probes}  {self.locate_ms} ms  "
            f"used={len(self.used)} rediscovered={len(self.rediscovered)} "
            f"unresolved={len(self.unresolved)}"
        )


class _Discovery:
    """The fallback path, run at most once however many controls want it.

    Rediscovering three controls must not cost three probes. The first caller
    pays for the probe and every later one reads the same result.
    """

    def __init__(self, page: Any, hints: dict[str, str]) -> None:
        self.page = page
        self.hints = hints
        self.probes = 0
        self.form: Any = None
        self.error: Exception | None = None
        self._done = False

    def form_or_none(self) -> Any:
        if self._done:
            return self.form
        self._done = True
        from tegg import login as login_module          # imported late, on purpose

        self.probes += 1
        try:
            self.form = login_module.locate(self.page, self.hints)
        except Exception as error:                      # noqa: BLE001
            self.error = error
            self.form = None
        return self.form

    def payload_for(self, control: str, page_url: str) -> dict[str, Any] | None:
        """The discovered locator for one control, in the stored shape.

        Reuses ``LoginForm.describe()`` and the same regex the ingest adapter
        parses, so a value learned here and a value learned from an
        observations file are the same value -- otherwise the two paths would
        contradict each other every run.
        """
        form = self.form_or_none()
        if form is None:
            return None
        found = {
            name: (how, what) for name, how, what in _FIELD_DETAIL.findall(form.describe())
        }
        if control not in found:
            return None
        how, what = found[control]
        return {
            "component": "sign-in form",
            "purpose": LOGIN_FIELD_PURPOSE.get(control, f"the {control} control"),
            "preferred": {"by": how, "value": what},
            "selector_type": how,
            "fallbacks": [],
            "page": page_url,
        }


def _resolve_control(
    run: KnowledgeRun,
    page: Any,
    control: str,
    discovery: _Discovery,
    telemetry: LoginTelemetry,
) -> Any:
    """Get one control's locator, from the store if it still works.

    Returns the locator, or ``None`` if neither the store nor rediscovery
    could produce one. The outcome is recorded against the record either way:
    that recording is the whole point of going through ``resolve``.
    """
    record_id = CONTROL_RECORDS[control]
    found: dict[str, Any] = {}

    def attempt(payload: dict[str, Any]) -> bool:
        # Read-only: resolve the locator and count what it matches. Nothing is
        # filled, clicked or submitted here.
        locator = locator_from(payload, page)
        if locator is None or locator.count() == 0:
            return False
        found["locator"] = locator
        return True

    def discover() -> dict[str, Any] | None:
        return discovery.payload_for(control, page.url)

    outcome = run.resolve(record_id, attempt=attempt, discover=discover, url=page.url)
    if outcome.ok:
        (telemetry.rediscovered if outcome.rediscovered else telemetry.used).append(
            record_id
        )
        return found.get("locator")
    telemetry.unresolved.append(record_id)
    return None


def _contractor_from_knowledge(
    run: KnowledgeRun, page: Any, telemetry: LoginTelemetry
) -> tuple[Any, bool, list[str], bool]:
    """The contractor picker, if the store knows about one.

    Returns ``(locator, required, options, accounted_for)``. The last flag is
    the important one: ``False`` means the page has a select this module
    cannot explain, which is a reason to fall back to discovery rather than to
    sign in with a form only partly understood.
    """
    found: dict[str, Any] = {}

    def attempt(payload: dict[str, Any]) -> bool:
        control = str(payload.get("control") or "").strip()
        if not control:
            return False
        locator = page.locator(
            f"select[name='{control}' i], select[id='{control}' i], "
            f"select[type='{control}' i]"
        ).first
        if locator.count() == 0:
            return False
        found["locator"] = locator
        return True

    if run.usable(CONTRACTOR_RECORD) is not None:
        # No ``discover`` on purpose: a picker that moved is a change to the
        # sign-in form, and working out what the form now is belongs to the
        # discovery path, not to a control-by-control repair.
        outcome = run.resolve(CONTRACTOR_RECORD, attempt=attempt, url=page.url)
        if not outcome.ok:
            telemetry.unresolved.append(CONTRACTOR_RECORD)
            return None, False, [], False
        telemetry.used.append(CONTRACTOR_RECORD)
        locator = found["locator"]
        try:
            options = [o.strip() for o in locator.locator("option").all_inner_texts()]
            required = locator.get_attribute("required") is not None
        except Exception:                               # noqa: BLE001
            return None, False, [], False
        return locator, required, [o for o in options if o], True

    # Nothing is known about a picker. That is only safe if the page has none.
    try:
        return None, False, [], page.locator("select").count() == 0
    except Exception:                                   # noqa: BLE001
        return None, False, [], False


def locate_login(
    run: KnowledgeRun | None,
    page: Any,
    hints: dict[str, str] | None = None,
    *,
    allow_rediscovery: bool = True,
) -> tuple[Any, LoginTelemetry]:
    """Locate the sign-in controls, preferring what an earlier run learned.

    Always returns a ``tegg.login.LoginForm`` or raises ``LoginFormError`` --
    the caller cannot tell from the type whether knowledge was used, only from
    the telemetry. That is deliberate: the sign-in path must behave identically
    either way, so a knowledge failure can never be worse than not having it.
    """
    from tegg import login as login_module              # imported late, on purpose

    hints = hints or {}
    telemetry = LoginTelemetry()
    discovery = _Discovery(page, hints)
    started = time.monotonic()

    def finish(form: Any, source: str, detail: str = "") -> tuple[Any, LoginTelemetry]:
        telemetry.source = source
        telemetry.detail = detail
        telemetry.dom_probes = discovery.probes
        telemetry.locate_ms = int((time.monotonic() - started) * 1000)
        return form, telemetry

    def by_discovery(detail: str) -> tuple[Any, LoginTelemetry]:
        form = discovery.form_or_none()
        if form is None:
            telemetry.dom_probes = discovery.probes
            telemetry.locate_ms = int((time.monotonic() - started) * 1000)
            raise discovery.error or login_module.LoginFormError(
                "the sign-in form could not be located"
            )
        return finish(form, "discovery", detail)

    if run is None or run.document is None:
        return by_discovery("no knowledge run was opened")

    if not any(run.usable(rid) for rid in CONTROL_RECORDS.values()):
        return by_discovery("nothing usable is stored about this sign-in form")

    contractor, required, options, accounted = _contractor_from_knowledge(
        run, page, telemetry
    )
    if not accounted:
        return by_discovery(
            "the sign-in page carries a control the store cannot account for"
        )

    located: dict[str, Any] = {}
    for control in ("password", "username", "submit"):
        if not allow_rediscovery and run.usable(CONTROL_RECORDS[control]) is None:
            return by_discovery(f"no usable knowledge for {control}")
        located[control] = _resolve_control(run, page, control, discovery, telemetry)

    # The submit button is genuinely optional -- pressing Enter in the password
    # field submits most forms, which is what the discovery path does too.
    if located["username"] is None or located["password"] is None:
        return by_discovery("stored knowledge could not produce a usable form")

    form = login_module.LoginForm(
        # ``page`` stands in for the frame. Everything the caller does with
        # ``form.frame`` -- filling extra fields -- works the same on a page,
        # and the knowledge path is only taken when the controls resolved from
        # the page in the first place.
        frame=page,
        username=located["username"],
        password=located["password"],
        submit=located["submit"],
        contractor=contractor,
        contractor_required=required,
        contractor_options=options,
        how={
            control: _how_for(run, CONTROL_RECORDS[control])
            for control in ("password", "username", "submit")
            if located[control] is not None
        },
    )
    source = "knowledge+repair" if telemetry.rediscovered else "knowledge"
    return finish(form, source, "signed in on stored knowledge")


def _how_for(run: KnowledgeRun, record_id: str) -> str:
    """The stored locator, in the same wording the discovery path prints."""
    record = run.get(record_id)
    preferred = (record.payload.get("preferred") or {}) if record else {}
    by, value = preferred.get("by", "?"), preferred.get("value", "?")
    return f"{by}={value!r}"
