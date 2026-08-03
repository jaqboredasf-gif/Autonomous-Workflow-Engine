"""The one operation a coworker can start today.

    sign in -> locate the TEGG workspace -> reach the Documentation area ->
    verify the page -> list the documentation records -> finish, read-only

Everything else in this package exists to make the third step honest. That step
is where stored knowledge is spent, where the portal is allowed to disagree with
it, and where a disagreement turns into corrected knowledge instead of into a
retry loop.

The shape of that step, in order:

  1. **Retrieve.** Take the best usable navigation knowledge and write down
     which record and which version is about to be applied. A run that cannot
     say what it believed cannot be held to it afterwards.
  2. **Apply as written.** Perform exactly the steps the record carries -- no
     more. A record with no settle step is applied with no settle step. This
     matters: the whole reason the stored navigation record was useless is that
     it described the area in a sentence and carried nothing a run could check,
     and papering over that in code would hide the defect instead of repairing
     it.
  3. **Compare against the live page.** Strong markers, not "did the URL
     change".
  4. **On contradiction: stop.** One structured contradiction, one demotion,
     no retry of the dead step, and no success recorded against knowledge that
     did not work.
  5. **Discover, bounded and read-only.** Only routes the portal is offering
     right now, inside a hard action and time limit.
  6. **Replace, through the normal rules.** The discovered procedure enters at
     DISCOVERED with the live run's provenance on it, supersedes the record it
     replaces, and earns trust the same way everything else does.

A later run then finds the replacement and simply uses it. That is the whole
claim, and ``list_records`` is what makes it worth making.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

from awe_knowledge.adapters import tegg_portal
from awe_knowledge.models import KnowledgeError, RecordKind
from awe_knowledge.runtime import KnowledgeRun
from awe_knowledge.store import KnowledgeStore

from . import discovery as discovery_module
from . import markers as marker_module
from .checkpoint import RunLedger, make_run_id
from .guard import Budget, ReadOnlyPage, ReadOnlyViolation

OPERATION = "documentation-read"

#: The record that used to describe how to reach the area, and the procedure
#: that replaces it. The old id stays spelled out here because a run has to be
#: able to name what it stopped believing.
STALE_RECORD_ID = "navigation:documentation-area"
PROCEDURE_KIND = RecordKind.PROCEDURE
PROCEDURE_NAME = "documentation-read.reach-documentation"
PROCEDURE_RECORD_ID = f"{PROCEDURE_KIND.value}:{PROCEDURE_NAME}"

#: Where credentials are read from. The names are safe to print and to store;
#: the values are never read into anything that gets written down.
CREDENTIAL_SOURCE = "environment: TEGG_USERNAME, TEGG_PASSWORD"

#: How long a step may wait for a single-page app to render before calling the
#: route dead. Two seconds is the observed figure on this portal; the budget is
#: ten times that so a slow morning is not mistaken for a deleted route.
SETTLE_BUDGET_MS = 20000


class OperationError(RuntimeError):
    """The run cannot go on, and the ledger says why."""


class Escalated(OperationError):
    """The run stopped and handed the problem to a person, on purpose."""


@dataclass
class OperationResult:
    """Everything the operator output is rendered from."""

    run_id: str = ""
    status: str = ""
    steps_completed: list[str] = field(default_factory=list)
    records: list[dict[str, Any]] = field(default_factory=list)
    rows_on_first_page: int = 0
    pages_read: int = 0
    knowledge_used: list[dict[str, Any]] = field(default_factory=list)
    stale_knowledge: list[dict[str, Any]] = field(default_factory=list)
    corrected_knowledge: list[dict[str, Any]] = field(default_factory=list)
    contradictions: list[dict[str, Any]] = field(default_factory=list)
    human_action_required: list[str] = field(default_factory=list)
    external_changes: list[dict[str, Any]] = field(default_factory=list)
    resume_command: str = ""
    evidence_dir: str = ""
    rediscovered: bool = False
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def ok(self) -> bool:
        from .checkpoint import COMPLETED

        return self.status == COMPLETED


# ---------------------------------------------------------------------------
# Knowledge: retrieve, apply, contradict, replace
# ---------------------------------------------------------------------------


@dataclass
class Applied:
    """Which piece of knowledge a step spent, and how it went."""

    record_id: str = ""
    version: int = 0
    trust: str = ""
    ok: bool = False
    settle_ms: int = 0
    verdict: dict[str, Any] = field(default_factory=dict)
    steps: list[dict[str, Any]] = field(default_factory=list)
    detail: str = ""


def navigation_knowledge(run: KnowledgeRun) -> Any:
    """The best navigation knowledge available, replacement first.

    Preferring the replacement is what makes the corrected procedure actually
    get used rather than merely stored. If it is not usable yet the run falls
    back to the record it was meant to replace, which is how the very first run
    finds the stale one and gets the chance to notice.
    """
    for record_id in (PROCEDURE_RECORD_ID, STALE_RECORD_ID):
        record = run.usable(record_id)
        if record is not None:
            return record
    return None


def steps_from(record: Any, base_url: str) -> list[dict[str, Any]]:
    """The steps a record actually instructs a run to perform.

    A procedure record carries them. A navigation record does not -- it carries
    a sentence about what should be on screen afterwards -- so it yields one
    step, a navigation, and nothing that would let the run wait or check. That
    asymmetry is the defect, expressed rather than hidden.
    """
    payload = dict(record.payload or {})
    stored = payload.get("steps")
    if isinstance(stored, list) and stored:
        return [dict(s) for s in stored if isinstance(s, dict)]

    url = str(payload.get("url") or payload.get("route") or "")
    if url and not url.startswith("http"):
        url = base_url.rstrip("/") + "/" + url.lstrip("/")
    return [{"action": "goto", "url": url}] if url else []


def apply_navigation(
    record: Any, page: ReadOnlyPage, *, base_url: str
) -> Applied:
    """Run one navigation record exactly as it is written, then judge the page.

    The markers used are the record's own if it carries any. A record with none
    is judged against the area's standard markers -- it still has to be *the
    Documentation area*, and a record that cannot say how to tell has not
    earned a softer test.
    """
    applied = Applied(
        record_id=record.record_id,
        version=record.version,
        trust=record.trust.value,
        steps=steps_from(record, base_url),
    )
    if not applied.steps:
        applied.detail = "the record instructs no action a run can perform"
        return applied

    markers = dict(record.payload.get("markers") or {}) or None
    settle_budget = 0
    for step in applied.steps:
        action = str(step.get("action", ""))
        if action == "goto":
            page.goto(str(step.get("url", "")))
        elif action == "settle":
            settle_budget = max(settle_budget, int(step.get("budget_ms", 0)))

    verdict, _observation, waited = marker_module.settle_until_verified(
        page, markers, budget_ms=settle_budget
    )
    applied.settle_ms = waited
    applied.verdict = verdict.to_dict()
    applied.ok = verdict.ok
    applied.detail = verdict.describe()
    return applied


def build_replacement_payload(
    result: discovery_module.DiscoveryResult,
    *,
    base_url: str,
    run: KnowledgeRun,
    supersedes: str,
    settle_budget_ms: int = SETTLE_BUDGET_MS,
) -> dict[str, Any]:
    """The corrected procedure, with the live run's provenance welded on.

    Three things the record it replaces did not have, and the reason this one
    is worth trusting: an explicit wait, an explicit set of markers, and a
    named execution that watched both hold.
    """
    return {
        "steps": [
            {"action": "goto", "url": result.url},
            {
                "action": "settle",
                "until": "page_markers",
                "budget_ms": settle_budget_ms,
            },
            {"action": "verify", "markers": "the markers on this record"},
        ],
        "starting_state": "signed in, on the dashboard",
        "expected_result": "the Documentation area's visit list is on screen",
        "base_url": base_url,
        "route": result.route,
        "url": result.url,
        "markers": dict(result.markers),
        "observed_settle_ms": result.settle_ms,
        "settle_budget_ms": settle_budget_ms,
        "supersedes": supersedes,
        "discovery": "bounded read-only route discovery over live navigation",
        "provenance": {
            "execution_id": run.execution_id,
            "observed_at": run.clock(),
            "tenant": run.tenant,
            "integration": run.integration,
            "environment": run.environment,
            "verified_by_markers": result.verdict,
            "candidates_considered": [
                {
                    "url": c.get("url", ""),
                    "source": c.get("source", ""),
                    "label": c.get("label", ""),
                    "tried": c.get("tried", False),
                    "verified": c.get("verified", False),
                }
                for c in result.candidates
            ],
            "budget": dict(result.budget),
            "evidence": list(result.evidence),
        },
    }


def reach_documentation(
    run: KnowledgeRun,
    page: ReadOnlyPage,
    ledger: RunLedger,
    *,
    base_url: str,
    dashboard_url: str,
    settle_budget_ms: int = SETTLE_BUDGET_MS,
) -> Applied:
    """Get to the Documentation area, correcting the knowledge if it is wrong.

    Returns the application that actually landed there. Raises ``Escalated``
    when no route could be proved, which is the only honest outcome when the
    portal has moved somewhere this run cannot find.
    """
    record = navigation_knowledge(run)
    if record is None:
        ledger.escalate(
            "no usable navigation knowledge exists for this tenant. Run "
            "'tegg knowledge inspect' and seed it from a live run first."
        )
        raise Escalated("nothing is known about how to reach the Documentation area")

    ledger.used_knowledge(record.record_id, record.version, record.trust.value)
    applied = apply_navigation(record, page, base_url=base_url)

    if applied.ok:
        run.succeeded(
            record.record_id,
            url=tegg_portal.generalize_url(page.url),
            note=applied.detail,
            artifacts=list(_shot(page, ledger, "documentation-verified")),
        )
        return applied

    # -- the stored knowledge and the live portal disagree ------------------
    # Recorded once, demoted once, and not attempted again. Retrying a route
    # that just failed its own check produces a second failure and no new
    # information, and it is how one bad afternoon writes off a document.
    believed = record.payload.get("expected_result") or record.payload.get("url") or ""
    contradiction = run.contradicted(
        record.record_id,
        field="expected_result" if record.payload.get("expected_result") else "url",
        believed=believed,
        observed=applied.verdict,
        reason=(
            f"applied as written and the page did not verify: {applied.detail}"
        ),
        note=(
            "the record carries no settle step and no page markers, so it was "
            "applied and judged exactly as written"
        ),
        url=tegg_portal.generalize_url(page.url),
        artifacts=list(_shot(page, ledger, "contradiction")),
    )
    ledger.record_contradiction(contradiction)

    # -- bounded, read-only discovery from the portal's own navigation ------
    page.goto(dashboard_url)
    result = discovery_module.discover_documentation(
        page,
        base_url=base_url,
        settle_budget_ms=settle_budget_ms,
        evidence_dir=ledger.evidence,
    )
    if not result.ok:
        ledger.escalate(result.escalation or result.reason)
        ledger.data["discovery"] = result.to_dict()
        ledger.save()
        raise Escalated(result.reason)

    # -- the replacement, through the normal validation rules ---------------
    payload = build_replacement_payload(
        result, base_url=base_url, run=run, supersedes=record.record_id,
        settle_budget_ms=settle_budget_ms,
    )
    try:
        replacement = run.replace(
            record.record_id,
            kind=PROCEDURE_KIND,
            name=PROCEDURE_NAME,
            payload=payload,
            reason=f"the stored route did not verify: {applied.detail}",
            note="discovered live by bounded read-only route discovery",
        )
    except KnowledgeError as error:
        ledger.escalate(f"a replacement procedure could not be stored: {error}")
        raise Escalated(str(error)) from error

    run.succeeded(
        replacement.record_id,
        url=tegg_portal.generalize_url(result.url),
        note=result.reason,
        artifacts=list(result.evidence),
    )
    ledger.record_correction(
        replacement.record_id, replacement.version, replacement.trust.value,
        supersedes=record.record_id,
    )
    ledger.data["discovery"] = result.to_dict()
    ledger.save()

    return Applied(
        record_id=replacement.record_id,
        version=replacement.version,
        trust=replacement.trust.value,
        ok=True,
        settle_ms=result.settle_ms,
        verdict=result.verdict,
        steps=payload["steps"],
        detail=result.reason,
    )


def _shot(page: ReadOnlyPage, ledger: RunLedger, tag: str) -> list[str]:
    saved = page.screenshot(ledger.evidence / f"{tag}.png")
    return [saved] if saved else []


# ---------------------------------------------------------------------------
# The operation
# ---------------------------------------------------------------------------


@dataclass
class Settings:
    """Everything the operation needs that is not a secret."""

    base_url: str = tegg_portal.BASE_URL
    tenant: str = tegg_portal.TENANT
    integration: str = tegg_portal.INTEGRATION
    environment: str = tegg_portal.ENVIRONMENT
    contractor: str = "Lippolis"
    login_path: str = "/auth/login"
    dashboard_path: str = "/sales/gm-dashboard"
    visit_timeframe: str = "All Site Visits"
    login_labels: dict[str, str] = field(default_factory=dict)
    login_timeout_ms: int = 30000
    timeout_ms: int = 30000
    max_list_pages: int = 20
    discovery_actions: int = 12
    discovery_seconds: float = 120.0
    settle_budget_ms: int = SETTLE_BUDGET_MS
    headless: bool = True
    #: Where the knowledge store lives. None means the repository's own store,
    #: which is what an operator gets. Tests point it at a temporary directory
    #: so no test can reach, or change, the real one.
    store_root: Path | None = None

    @property
    def dashboard_url(self) -> str:
        return self.base_url.rstrip("/") + self.dashboard_path

    def portal_settings(self) -> dict[str, Any]:
        """The dict the existing TEGG driver expects."""
        return {
            "login_path": self.login_path,
            "login_labels": dict(self.login_labels),
            "login_timeout_ms": self.login_timeout_ms,
            "timeout_ms": self.timeout_ms,
            "contractor": self.contractor,
            "dashboard_path": self.dashboard_path,
            "visit_timeframe": self.visit_timeframe,
            "max_list_pages": self.max_list_pages,
            # Deliberately absent: documentation_path and documentation_labels.
            # Where the area lives is knowledge now, not configuration, and a
            # config fallback would quietly re-introduce the guessing this
            # whole slice exists to remove.
        }


def load_settings(path: Path | str | None = None, **overrides: Any) -> Settings:
    """Read the non-secret service file, if there is one, and apply overrides.

    The service file holds a base URL, a tenant and a contractor. It must never
    hold a credential; a file that carries one is refused rather than read, so
    a well-meaning coworker cannot make one work by pasting a password into it.
    """
    data: dict[str, Any] = {}
    if path:
        import yaml

        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise OperationError(f"{path}: expected a YAML mapping")
        data = dict(raw.get("service") or raw)
        banned = sorted(
            k for k in data
            if any(word in str(k).lower()
                   for word in ("password", "secret", "token", "credential", "cookie"))
        )
        if banned:
            raise OperationError(
                f"{path} carries {', '.join(banned)}. Credentials come from the "
                "environment only -- remove them from this file."
            )
    known = {f for f in Settings.__dataclass_fields__}
    merged = {k: v for k, v in data.items() if k in known}
    merged.update({k: v for k, v in overrides.items() if v is not None and k in known})
    return Settings(**merged)


def credentials_present() -> list[str]:
    """Which required credentials are missing. Values are never touched."""
    return [
        name for name in ("TEGG_USERNAME", "TEGG_PASSWORD")
        if not os.environ.get(name)
    ]


@contextmanager
def _knowledge(ledger: RunLedger, settings: Settings) -> Iterator[KnowledgeRun]:
    """One knowledge run, opened for this execution and always closed.

    Closed in a ``finally`` on purpose: a run that failed halfway is the run
    with the most to say, and dropping its report would throw away the
    contradiction it just found.
    """
    run = KnowledgeRun(
        KnowledgeStore(settings.store_root),
        settings.tenant,
        settings.integration,
        settings.environment,
        execution_id=ledger.run_id,
        # A corrected procedure is CANDIDATE until a second distinct execution
        # confirms it. Spending a candidate is safe *here* and nowhere else,
        # because every navigation is verified by markers on arrival: the worst
        # a wrong candidate costs is one page load and a demotion.
        allow_candidate=True,
        artifact_root=ledger.evidence,
    )
    run.open(base_url=settings.base_url)
    try:
        yield run
    finally:
        report = run.close(note=f"{OPERATION} {ledger.run_id}")
        ledger.data["knowledge_report"] = {
            "document_version": report.document_version,
            "used": report.used,
            "rediscovered": report.rediscovered,
            "changes": report.changes,
            "contradictions": report.contradictions,
            "pending_approval": report.pending_approval,
            "saved_to": report.saved_to,
        }
        ledger.save()


def run_operation(
    ledger: RunLedger,
    settings: Settings,
    *,
    on_step: Callable[[str], None] | None = None,
) -> OperationResult:
    """Drive the operation from wherever the ledger says it got to.

    ``on_step`` is called with each step name just before it runs. Tests use it
    to interrupt at a chosen point; nothing else does.
    """
    from tegg import evidence as tegg_evidence
    from tegg import fetch as fetch_module

    missing = credentials_present()
    if missing:
        ledger.escalate(
            f"{' and '.join(missing)} not set. Export them and run the resume "
            "command; nothing is stored between runs."
        )
        raise Escalated(f"missing credentials: {', '.join(missing)}")

    def announce(step: str) -> None:
        if on_step is not None:
            on_step(step)

    announce("open_knowledge")
    with _knowledge(ledger, settings) as run:
        known = [r.record_id for r in run.applicable()]
        ledger.checkpoint(
            "open_knowledge",
            f"{len(known)} usable record(s)",
            usable=known,
            document_version=run.document.document_version if run.document else 0,
        )

        recorder = tegg_evidence.Recorder(ledger.evidence)
        announce("sign_in")
        with fetch_module.session(
            settings.base_url,
            recorder,
            settings.portal_settings(),
            headless=settings.headless,
            knowledge=run,
        ) as explorer:
            ledger.checkpoint("sign_in", "signed in", url=explorer.page.url)

            announce("locate_workspace")
            workspace = _locate_workspace(explorer, run, settings)
            ledger.checkpoint(
                "locate_workspace",
                workspace["detail"],
                **{k: v for k, v in workspace.items() if k != "detail"},
            )

            budget = Budget(
                max_actions=settings.discovery_actions,
                max_seconds=settings.discovery_seconds,
                allowed_hosts=_allowed_hosts(settings.base_url),
            )
            page = ReadOnlyPage(explorer.page, budget)

            announce("reach_documentation")
            applied = reach_documentation(
                run, page, ledger,
                base_url=settings.base_url,
                dashboard_url=settings.dashboard_url,
                settle_budget_ms=settings.settle_budget_ms,
            )
            ledger.checkpoint(
                "reach_documentation",
                applied.detail,
                record_id=applied.record_id,
                version=applied.version,
                trust=applied.trust,
                settle_ms=applied.settle_ms,
                url=page.url,
                rediscovered=applied.record_id == PROCEDURE_RECORD_ID
                and bool(ledger.data.get("contradictions")),
            )

            announce("verify_documentation")
            verdict = marker_module.verify(marker_module.observe(page))
            if not verdict.ok:
                ledger.escalate(
                    "the Documentation area stopped verifying between reaching "
                    f"it and re-checking it: {verdict.describe()}"
                )
                raise Escalated(verdict.describe())
            ledger.checkpoint(
                "verify_documentation", verdict.describe(),
                url=page.url, markers=verdict.to_dict(),
            )

            announce("list_records")
            listing = _list_records(explorer, settings, ledger)
            ledger.checkpoint(
                "list_records",
                f"{len(listing['records'])} completed record(s) across "
                f"{listing['pages_read']} page(s)",
                **listing,
            )

        announce("finish")
        ledger.checkpoint("finish", "finished read-only; nothing was submitted")
        ledger.complete()

    return result_from(ledger)


def _allowed_hosts(base_url: str) -> tuple[str, ...]:
    from urllib.parse import urlparse

    host = (urlparse(base_url).hostname or "").lower()
    return (host,) if host else ()


def _locate_workspace(explorer: Any, run: KnowledgeRun, settings: Settings) -> dict[str, Any]:
    """Confirm the session landed in the workspace this tenant's knowledge is for.

    Cheap, and the thing that stops a run from spending one contractor's
    knowledge against another contractor's data. The expected workspace name
    comes from the store, not from a constant.
    """
    record = run.usable("auth:contractor-selection")
    expected = ""
    if record is not None:
        expected = str(
            record.payload.get("resolves_to")
            or record.payload.get("configured_value")
            or ""
        )
        run.report.used.append(record.record_id)
    expected = expected or settings.contractor
    token = settings.contractor or expected

    try:
        text = explorer.page.inner_text("body")
    except Exception:                                       # noqa: BLE001
        text = ""
    for _ in range(10):
        if token.lower() in text.lower():
            break
        explorer.page.wait_for_timeout(500)
        try:
            text = explorer.page.inner_text("body")
        except Exception:                                   # noqa: BLE001
            text = ""

    matched = token.lower() in text.lower()
    if not matched:
        raise OperationError(
            f"signed in, but the page never named the {token!r} workspace. "
            "Refusing to read another contractor's data."
        )
    return {
        "detail": f"workspace {expected!r} confirmed on the signed-in page",
        "workspace": expected,
        "tenant": settings.tenant,
        "url": explorer.page.url,
        "knowledge": record.record_id if record is not None else "",
    }


def _list_records(explorer: Any, settings: Settings, ledger: RunLedger) -> dict[str, Any]:
    """Capture the documentation records on screen. Reads only.

    One client-side interaction is allowed here and nowhere else: widening the
    list's own timeframe filter. It submits nothing, changes nothing the portal
    keeps, and without it the list shows only the last few weeks. It is
    reported in the run's ``external changes`` line either way, so the operator
    sees exactly what the run touched.
    """
    explorer.wait_for_content()
    if settings.visit_timeframe and explorer.set_timeframe(settings.visit_timeframe):
        ledger.data.setdefault("external_changes", []).append(
            {
                "kind": "client-side view filter",
                "detail": f"list timeframe set to {settings.visit_timeframe!r}",
                "submitted_to_portal": False,
                "persisted": False,
            }
        )
        ledger.save()

    first_page = len(explorer._raw_rows())
    visits = explorer.list_completed_site_visits()
    # The driver pages through the list itself, so how much was read comes from
    # its own observation rather than from a count taken before or after. A
    # single page's row count would read as the whole list and quietly
    # understate what the run covered.
    pages_read = 1
    for observation in reversed(explorer.recorder.observations):
        if observation.step == "list_pagination":
            digits = "".join(c for c in observation.detail if c.isdigit())
            pages_read = int(digits or 1)
            break
    return {
        "records": [v.to_dict() for v in visits],
        "rows_on_first_page": first_page,
        "pages_read": pages_read,
        "timeframe": settings.visit_timeframe,
    }


def result_from(ledger: RunLedger) -> OperationResult:
    """Render the ledger into the shape the operator output is printed from."""
    data = ledger.data
    return OperationResult(
        run_id=ledger.run_id,
        status=ledger.status,
        steps_completed=ledger.completed_steps(),
        records=list(_last(data, "list_records", "records") or []),
        rows_on_first_page=int(_last(data, "list_records", "rows_on_first_page") or 0),
        pages_read=int(_last(data, "list_records", "pages_read") or 0),
        knowledge_used=list(data.get("knowledge_used", [])),
        stale_knowledge=list(data.get("stale_knowledge", [])),
        corrected_knowledge=list(data.get("corrected_knowledge", [])),
        contradictions=list(data.get("contradictions", [])),
        human_action_required=list(data.get("human_action_required", [])),
        external_changes=list(data.get("external_changes", [])),
        resume_command=ledger.resume_command(),
        evidence_dir=str(ledger.evidence),
        rediscovered=bool(data.get("corrected_knowledge")),
        notes=[n.get("message", "") for n in data.get("notes", [])],
    )


def _last(data: dict[str, Any], step: str, key: str) -> Any:
    for entry in reversed(data.get("steps", [])):
        if entry.get("step") == step:
            return (entry.get("data") or {}).get(key)
    return None


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def start(
    settings: Settings,
    *,
    work_root: Path | str = "work",
    run_id: str | None = None,
    on_step: Callable[[str], None] | None = None,
) -> OperationResult:
    """Begin a fresh run of the operation."""
    ledger = RunLedger.create(
        work_root,
        run_id or make_run_id(OPERATION),
        operation=OPERATION,
        tenant=settings.tenant,
        integration=settings.integration,
        environment=settings.environment,
        base_url=settings.base_url,
        credential_source=CREDENTIAL_SOURCE,
    )
    return _drive(ledger, settings, on_step)


def resume(
    settings: Settings,
    run_id: str,
    *,
    work_root: Path | str = "work",
    on_step: Callable[[str], None] | None = None,
) -> OperationResult:
    """Continue a run from its last verified checkpoint.

    A run that already finished is not run again. That is not an optimisation:
    re-running would sign in again and re-read a customer's records for no
    reason, and the answer is already on disk.
    """
    ledger = RunLedger.find(work_root, run_id)
    from .checkpoint import COMPLETED

    if ledger.status == COMPLETED:
        ledger.note("resume asked for a run that was already complete; nothing re-run")
        return result_from(ledger)
    ledger.mark_resumed()
    return _drive(ledger, settings, on_step)


def _drive(
    ledger: RunLedger,
    settings: Settings,
    on_step: Callable[[str], None] | None,
) -> OperationResult:
    try:
        return run_operation(ledger, settings, on_step=on_step)
    except Escalated:
        return result_from(ledger)
    except ReadOnlyViolation as violation:
        ledger.fail(f"a step tried to act on the portal and was refused: {violation}")
        return result_from(ledger)
    except (OperationError, KnowledgeError) as error:
        ledger.fail(str(error))
        return result_from(ledger)
    except KeyboardInterrupt:
        ledger.interrupt("interrupted by the operator")
        raise
    except Exception as error:                              # noqa: BLE001
        ledger.interrupt(f"{type(error).__name__}: {error}")
        raise
