"""The second operation: one completed site visit, read end to end.

    sign in -> reach Documentation -> choose one completed visit ->
    put the portal in that site's context -> retrieve the Standard IR Report
    and the Equipment Item Problems Report -> read the findings out of them ->
    recommend -> estimate -> validate -> write something a coworker can review

Read-only with respect to TEGG throughout. It renders two reports, which is a
read: the documents are built from data that is already there, and no TEGG
record is created, changed, submitted, approved or sent.

It reuses everything ``documentation-read`` proved rather than forking it: the
same run ledger, the same knowledge store and ``KnowledgeRun``, the same
sign-in, the same page markers, the same secret screen. What is new is the four
steps after the list, and one rule about the list itself.

## Choosing the visit

Never hard-coded, and never "the first row". ``--site-visit <id>`` picks one
explicitly. Without it the rule is stated, applied and printed:

    the most recently completed visit that has an agreement, a site and an
    identifier, ordered by end date, then start date, then identifier

Ties break on the identifier so two runs a minute apart cannot disagree, which
is what makes a rerun idempotent rather than merely similar.

## Resuming

Steps whose result is a file on disk are not redone. A resume that already has
both PDFs -- checksums matching what the ledger recorded -- does not sign into
TEGG at all. Re-rendering a customer's reports because a laptop lid closed is
not free, and it is not polite.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from awe_knowledge.models import KnowledgeError

from . import documents as documents_module
from . import estimate as estimate_module
from . import findings as findings_module
from . import markers as marker_module
from . import recommend as recommend_module
from . import review as review_module
from .checkpoint import COMPLETED, RunLedger, make_run_id
from .documents import RetrievalBudget, RetrievalError
from .guard import Budget, ReadOnlyPage
from .operation import (
    CREDENTIAL_SOURCE,
    Escalated,
    OperationError,
    OperationResult,
    Settings,
    _allowed_hosts,
    _knowledge,
    _list_records,
    _locate_workspace,
    credentials_present,
    reach_documentation,
)

OPERATION = "visit-findings"

#: The steps, in order. The ledger uses this to decide what a resume may skip.
STEPS: tuple[str, ...] = (
    "open_knowledge",
    "sign_in",
    "locate_workspace",
    "reach_documentation",
    "select_visit",
    "open_visit_context",
    "retrieve_documents",
    "extract_findings",
    "recommend_repairs",
    "build_estimate",
    "validate_result",
    "publish_review",
    "finish",
)

#: Steps that need a live browser. A resume re-establishes these rather than
#: skipping them; everything else after the last durable checkpoint is redone.
PRECONDITION_STEPS = frozenset({"sign_in", "locate_workspace", "reach_documentation"})

#: Steps that produce a durable artefact and are therefore skippable on resume
#: *if* the artefact is still there and still matches its recorded checksum.
DURABLE_STEPS = frozenset({"retrieve_documents"})

DEFAULT_RATE_CARD = Path("config/estimating.example.yaml")


@dataclass
class VisitSettings:
    """Everything ``visit-findings`` needs beyond the shared portal settings."""

    site_visit: str = ""
    rate_card: Path = DEFAULT_RATE_CARD
    retrieval_actions: int = 40
    retrieval_seconds: float = 900.0
    include_corrected: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "site_visit": self.site_visit,
            "rate_card": str(self.rate_card),
            "retrieval_actions": self.retrieval_actions,
            "retrieval_seconds": self.retrieval_seconds,
            "include_corrected": self.include_corrected,
        }


# ---------------------------------------------------------------------------
# Choosing the visit
# ---------------------------------------------------------------------------

SELECTION_RULE = (
    "the most recently completed visit carrying an agreement, a site and an "
    "identifier -- ordered by end date, then start date, then identifier"
)


def _date_key(value: str) -> tuple[int, int, int]:
    """A sortable date from the portal's ``M/D/YYYY``. Unparseable sorts last."""
    parts = (value or "").split("/")
    if len(parts) != 3:
        return (0, 0, 0)
    try:
        month, day, year = (int(p) for p in parts)
    except ValueError:
        return (0, 0, 0)
    return (year, month, day)


def eligible(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        r for r in records
        if str(r.get("status", "")).lower() == "completed"
        and r.get("identifier") and r.get("agreement")
        and (r.get("site") or r.get("customer"))
    ]


def choose_visit(
    records: list[dict[str, Any]], wanted: str = ""
) -> tuple[dict[str, Any], str]:
    """Pick exactly one visit. Ambiguity is an error, never a guess."""
    usable = eligible(records)
    if not usable:
        raise Escalated(
            f"none of the {len(records)} listed visit(s) is completed with an "
            "agreement, a site and an identifier, so there is nothing to read"
        )

    if wanted:
        matches = [r for r in usable if r.get("identifier") == wanted]
        if not matches:
            loose = [
                r for r in usable
                if wanted.lower() in str(r.get("identifier", "")).lower()
            ]
            matches = loose
        if not matches:
            available = ", ".join(str(r["identifier"]) for r in usable[:12])
            raise Escalated(
                f"site visit {wanted!r} is not in the completed list. The first "
                f"few that are: {available}"
            )
        if len(matches) > 1:
            found = ", ".join(str(r["identifier"]) for r in matches)
            raise Escalated(
                f"{wanted!r} matched {len(matches)} visits ({found}). Use the "
                "exact identifier."
            )
        return matches[0], f"chosen explicitly by identifier {wanted!r}"

    ordered = sorted(
        usable,
        key=lambda r: (
            _date_key(str(r.get("end_date") or r.get("date", ""))),
            _date_key(str(r.get("start_date", ""))),
            str(r.get("identifier", "")),
        ),
        reverse=True,
    )
    return ordered[0], (
        f"chosen by the standing rule: {SELECTION_RULE} "
        f"({len(usable)} visit(s) were eligible)"
    )


# ---------------------------------------------------------------------------
# The operation
# ---------------------------------------------------------------------------


def run_operation(
    ledger: RunLedger,
    settings: Settings,
    visit_settings: VisitSettings,
    *,
    on_step: Callable[[str], None] | None = None,
) -> OperationResult:
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

    documents_dir = ledger.path / "documents"
    documents_dir.mkdir(parents=True, exist_ok=True)

    reusable = _reusable_documents(ledger, documents_dir)
    if reusable:
        ledger.note(
            "both reports were already retrieved by this run and their "
            "checksums still match, so the portal was not asked for them again"
        )

    visit: dict[str, Any] = dict(ledger.data.get("visit") or {})
    retrieved: dict[str, Any] = dict(reusable)

    if not reusable or not visit:
        announce("open_knowledge")
        with _knowledge(ledger, settings) as run:
            known = [r.record_id for r in run.applicable()]
            ledger.checkpoint(
                "open_knowledge", f"{len(known)} usable record(s)",
                usable=known,
                document_version=run.document.document_version if run.document else 0,
            )

            recorder = tegg_evidence.Recorder(ledger.evidence)
            announce("sign_in")
            with fetch_module.session(
                settings.base_url, recorder, settings.portal_settings(),
                headless=settings.headless, knowledge=run,
            ) as explorer:
                ledger.checkpoint("sign_in", "signed in", url=explorer.page.url)

                announce("locate_workspace")
                workspace = _locate_workspace(explorer, run, settings)
                ledger.checkpoint(
                    "locate_workspace", workspace["detail"],
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
                verdict = marker_module.verify(marker_module.observe(page))
                if not verdict.ok:
                    ledger.escalate(
                        "the Documentation area stopped verifying: "
                        f"{verdict.describe()}"
                    )
                    raise Escalated(verdict.describe())
                ledger.checkpoint(
                    "reach_documentation", applied.detail,
                    record_id=applied.record_id, version=applied.version,
                    trust=applied.trust, url=page.url,
                )

                announce("select_visit")
                listing = _list_records(explorer, settings, ledger)
                visit, why = choose_visit(
                    listing["records"], visit_settings.site_visit
                )
                ledger.data["visit"] = visit
                ledger.checkpoint(
                    "select_visit",
                    f"{visit['identifier']} -- {why}",
                    visit=visit, rule=SELECTION_RULE, reason=why,
                    eligible=len(eligible(listing["records"])),
                    listed=len(listing["records"]),
                )

                announce("open_visit_context")
                retrieval_budget = RetrievalBudget(
                    max_actions=visit_settings.retrieval_actions,
                    max_seconds=visit_settings.retrieval_seconds,
                )
                reports = documents_module.ReportRun(
                    explorer.page,
                    out_dir=documents_dir,
                    budget=retrieval_budget,
                    on_note=lambda message: None,
                )
                # Back to a clean Documentation page: the search box lives there.
                explorer.page.goto(
                    settings.base_url.rstrip("/") + "/sales/documentation",
                    wait_until="domcontentloaded",
                )
                explorer.page.wait_for_load_state("networkidle")
                try:
                    chosen_site = reports.select_site(
                        str(visit.get("site", "")), customer=str(visit.get("customer", ""))
                    )
                    offered = reports.open_report_list()
                except RetrievalError as error:
                    ledger.escalate(
                        f"the portal could not be put into this site's context: {error}"
                    )
                    raise Escalated(str(error)) from error
                ledger.checkpoint(
                    "open_visit_context",
                    f"site context {chosen_site!r} is open",
                    site=chosen_site, reports_offered=offered[:60],
                )

                announce("retrieve_documents")
                retrieved = _retrieve(reports, visit, ledger)
                ledger.checkpoint(
                    "retrieve_documents",
                    f"{len(retrieved)} report(s) retrieved, read-only",
                    documents=retrieved,
                    budget=retrieval_budget.to_dict(),
                )
    else:
        for step in ("open_knowledge", "sign_in", "locate_workspace",
                     "reach_documentation", "select_visit", "open_visit_context",
                     "retrieve_documents"):
            announce(step)

    # -- everything below is offline: no browser, no portal ----------------
    announce("extract_findings")
    finding_set = findings_module.build(
        equipment_item_problems=Path(retrieved["equipment_item_problems"]["path"]),
        standard_ir=(Path(retrieved["standard_ir"]["path"])
                     if "standard_ir" in retrieved else None),
        site_visit=str(visit.get("identifier", "")),
        customer=str(visit.get("customer", "")),
        site=str(visit.get("site", "")),
        agreement=str(visit.get("agreement", "")),
        contractor=settings.contractor,
    )
    ledger.checkpoint(
        "extract_findings",
        f"{len(finding_set.findings)} finding(s), "
        f"{len(finding_set.needing_estimate)} needing an estimate",
        counts=finding_set.to_dict()["counts"],
        warnings=finding_set.warnings,
    )

    announce("recommend_repairs")
    policy = recommend_module.Policy.from_mapping(
        settings.policy,
        source=("config/service.yaml" if settings.policy
                else "built-in defaults (nobody has confirmed these)"),
    )
    recommendations = recommend_module.recommend(finding_set, policy)
    ledger.checkpoint(
        "recommend_repairs",
        f"{len(recommendations.recommendations)} recommendation(s), "
        "each carrying the technician's own words and a citation",
        counts=recommendations.to_dict()["counts"],
        policy=policy.describe(),
    )

    announce("build_estimate")
    try:
        card = estimate_module.RateCard.load(visit_settings.rate_card)
    except estimate_module.RateCardError as error:
        ledger.escalate(str(error))
        raise Escalated(str(error)) from error
    estimate = estimate_module.estimate(
        recommendations, card, include_corrected=visit_settings.include_corrected
    )
    ledger.checkpoint(
        "build_estimate",
        f"{len(estimate.priced_lines)} of {len(estimate.lines)} item(s) sized; "
        f"status {estimate.status}",
        counts=estimate.to_dict()["counts"],
        totals=estimate.totals(),
        rate_card=str(visit_settings.rate_card),
        placeholder_rates=estimate.placeholder_rates,
    )

    announce("validate_result")
    problems = validate(finding_set, recommendations, estimate)
    if problems["fatal"]:
        for problem in problems["fatal"]:
            ledger.escalate(problem)
        raise Escalated("; ".join(problems["fatal"]))
    ledger.checkpoint(
        "validate_result",
        f"{len(problems['advisory'])} thing(s) flagged for a person, none fatal",
        **problems,
    )

    announce("publish_review")
    result = review_module.build(
        finding_set, recommendations, estimate,
        run_id=ledger.run_id, evidence_dir=str(ledger.path),
    )
    written = result.write(ledger.path / "review")
    ledger.data["review"] = {k: str(v) for k, v in written.items()}
    ledger.checkpoint(
        "publish_review",
        f"written to {written['markdown']}",
        **{k: str(v) for k, v in written.items()},
    )

    announce("finish")
    ledger.checkpoint(
        "finish",
        "finished read-only; nothing was submitted, approved, sent or changed",
    )
    ledger.complete()
    return result_from(ledger)


def _retrieve(
    reports: documents_module.ReportRun,
    visit: dict[str, Any],
    ledger: RunLedger,
) -> dict[str, Any]:
    """Both reports, or an escalation naming the one that did not come back."""
    agreement = str(visit.get("agreement", ""))
    identifier = str(visit.get("identifier", "visit"))
    wanted = (
        ("standard_ir", "Standard IR Report", documents_module.STANDARD_IR,
         f"{identifier}-StandardIRReport.pdf"),
        ("equipment_item_problems", "Equipment Item Problems Report",
         documents_module.EQUIPMENT_ITEM_PROBLEMS,
         f"{identifier}-EquipmentItemProblems.pdf"),
    )
    out: dict[str, Any] = {}
    failures: list[str] = []
    for key, name, path, filename in wanted:
        try:
            got = reports.retrieve(name, path, agreement=agreement, filename=filename)
        except RetrievalError as error:
            failures.append(f"{name}: {error}")
            continue
        record = got.to_dict()
        record["sha256"] = findings_module.checksum(Path(got.path))
        out[key] = record

    if "equipment_item_problems" not in out:
        detail = "; ".join(failures) or "no reason recorded"
        ledger.escalate(
            "the Equipment Item Problems Report could not be retrieved, and it "
            f"is what the findings are read from: {detail}"
        )
        raise Escalated(detail)
    if "standard_ir" not in out:
        ledger.note(
            "the Standard IR Report could not be retrieved; the findings stand "
            "without their thermal corroboration: "
            + ("; ".join(failures) or "no reason recorded")
        )
    return out


def _reusable_documents(ledger: RunLedger, directory: Path) -> dict[str, Any]:
    """Documents this run already fetched, if they are still exactly those.

    Checked by checksum rather than by existence. A file that changed under us
    is not the file the ledger is talking about, and re-fetching is cheaper
    than being wrong about which customer's report is on disk.
    """
    for entry in reversed(ledger.data.get("steps", [])):
        if entry.get("step") != "retrieve_documents":
            continue
        recorded = (entry.get("data") or {}).get("documents") or {}
        out: dict[str, Any] = {}
        for key, record in recorded.items():
            path = Path(record.get("path", ""))
            if not path.exists():
                return {}
            if record.get("sha256") and findings_module.checksum(path) != record["sha256"]:
                return {}
            out[key] = record
        return out if "equipment_item_problems" in out else {}
    return {}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate(
    finding_set: findings_module.FindingSet,
    recommendations: recommend_module.RecommendationSet,
    estimate: estimate_module.Estimate,
) -> dict[str, list[str]]:
    """Check the result against itself before anyone is shown it.

    ``fatal`` stops the run. ``advisory`` is printed and carried into the
    review, because a coworker who is told what the tool was unsure about can
    do something about it, and one who is not, cannot.
    """
    fatal: list[str] = []
    advisory: list[str] = []

    if not finding_set.findings and not finding_set.empty_reason:
        fatal.append("the reports produced no findings at all")
    if len(recommendations.recommendations) != len(finding_set.findings):
        fatal.append(
            f"{len(finding_set.findings)} finding(s) produced "
            f"{len(recommendations.recommendations)} recommendation(s); every "
            "finding must produce exactly one"
        )
    if len(estimate.lines) != len(recommendations.recommendations):
        fatal.append(
            f"{len(recommendations.recommendations)} recommendation(s) produced "
            f"{len(estimate.lines)} estimate line(s)"
        )

    for recommendation in recommendations.recommendations:
        if not recommendation.evidence:
            fatal.append(
                f"{recommendation.finding_id} carries no source citation"
            )
        if not recommendation.review_required:
            fatal.append(
                f"{recommendation.finding_id} is not marked as needing review"
            )

    for line in estimate.priced_lines:
        total = line.total
        if not (total.get("low", 0) <= total.get("expected", 0) <= total.get("high", 0)):
            fatal.append(f"{line.finding_id}: the estimate range is not ordered")
        if total.get("low", 0) < 0:
            fatal.append(f"{line.finding_id}: a negative total")

    if estimate.placeholder_rates and estimate.status != estimate_module.NOT_PRICED:
        fatal.append(
            "placeholder rates were used but the estimate is not stamped "
            f"{estimate_module.NOT_PRICED}"
        )

    unreadable = [f for f in finding_set.findings if f.warnings]
    if unreadable:
        advisory.append(
            f"{len(unreadable)} finding(s) had something the parser could not "
            "read cleanly; each says what on its own line"
        )
    undecided = [r for r in recommendations.recommendations if not r.work_type]
    if undecided:
        advisory.append(
            f"{len(undecided)} item(s) do not say whether to repair or replace "
            "and could not be sized"
        )
    if estimate.placeholder_rates:
        advisory.append(
            "the rate card is a placeholder, so no figure in this result is money"
        )
    if finding_set.empty_reason:
        advisory.append(
            "this visit recorded no equipment problems, corroborated by both "
            f"reports: {finding_set.empty_reason}"
        )
    elif not finding_set.needing_estimate:
        advisory.append(
            "no finding is marked 'Estimate Required'; there may be nothing to quote"
        )
    return {"fatal": fatal, "advisory": advisory}


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def result_from(ledger: RunLedger) -> OperationResult:
    data = ledger.data
    visit = data.get("visit") or {}
    review = data.get("review") or {}
    notes = [n.get("message", "") for n in data.get("notes", [])]
    return OperationResult(
        run_id=ledger.run_id,
        status=ledger.status,
        steps_completed=ledger.completed_steps(),
        records=[visit] if visit else [],
        knowledge_used=list(data.get("knowledge_used", [])),
        stale_knowledge=list(data.get("stale_knowledge", [])),
        corrected_knowledge=list(data.get("corrected_knowledge", [])),
        contradictions=list(data.get("contradictions", [])),
        human_action_required=list(data.get("human_action_required", [])),
        external_changes=list(data.get("external_changes", [])),
        resume_command=f"awe-tegg resume --run-id {ledger.run_id}",
        evidence_dir=str(ledger.path),
        notes=notes + ([f"review: {review.get('markdown')}"] if review else []),
    )


def start(
    settings: Settings,
    visit_settings: VisitSettings,
    *,
    work_root: Path | str = "work",
    run_id: str | None = None,
    on_step: Callable[[str], None] | None = None,
) -> OperationResult:
    ledger = _ledger(work_root, run_id or make_run_id(OPERATION), settings)
    ledger.data["visit_settings"] = visit_settings.to_dict()
    ledger.save()
    return _drive(ledger, settings, visit_settings, on_step)


def resume(
    settings: Settings,
    visit_settings: VisitSettings,
    run_id: str,
    *,
    work_root: Path | str = "work",
    on_step: Callable[[str], None] | None = None,
) -> OperationResult:
    ledger = RunLedger.find(
        work_root, run_id, steps=STEPS, precondition_steps=PRECONDITION_STEPS
    )
    if ledger.status == COMPLETED:
        ledger.note("resume asked for a run that was already complete; nothing re-run")
        return result_from(ledger)
    stored = ledger.data.get("visit_settings") or {}
    # The visit a run chose is part of that run. A resume may not silently
    # choose a different one because the list moved on.
    if stored.get("site_visit") and not visit_settings.site_visit:
        visit_settings.site_visit = str(stored["site_visit"])
    ledger.mark_resumed()
    return _drive(ledger, settings, visit_settings, on_step)


def _ledger(work_root: Path | str, run_id: str, settings: Settings) -> RunLedger:
    """A ledger that knows *this* operation's steps.

    The ledger refuses a step name it does not recognise, which is worth
    keeping -- a typo in a checkpoint name should be an error, not a silently
    unordered entry. So the step list travels with the operation rather than
    being relaxed into a union of everything.
    """
    return RunLedger.create(
        work_root, run_id,
        operation=OPERATION,
        tenant=settings.tenant,
        integration=settings.integration,
        environment=settings.environment,
        base_url=settings.base_url,
        credential_source=CREDENTIAL_SOURCE,
        steps=STEPS,
        precondition_steps=PRECONDITION_STEPS,
    )


def _drive(
    ledger: RunLedger,
    settings: Settings,
    visit_settings: VisitSettings,
    on_step: Callable[[str], None] | None,
) -> OperationResult:
    try:
        return run_operation(ledger, settings, visit_settings, on_step=on_step)
    except Escalated as stop:
        # An Escalated raised by something that did not first call
        # ledger.escalate() -- choose_visit, for one -- carries its reason only
        # in the exception. Without this the operator output says
        # "human action required: none" and the useful sentence is lost.
        if not ledger.data.get("human_action_required") and str(stop):
            ledger.escalate(str(stop))
        return result_from(ledger)
    except (OperationError, KnowledgeError, RetrievalError,
            findings_module.FindingsError) as error:
        # A failure a coworker cannot act on is a failure they will bring to
        # whoever wrote this. Every one of these carries a sentence about what
        # went wrong, so it belongs under "human action required" rather than
        # in a notes list they have no reason to look at.
        ledger.data.setdefault("human_action_required", []).append(str(error))
        ledger.fail(str(error))
        return result_from(ledger)
    except KeyboardInterrupt:
        ledger.interrupt("interrupted by the operator")
        raise
    except Exception as error:                              # noqa: BLE001
        ledger.interrupt(f"{type(error).__name__}: {error}")
        raise


__all__ = [
    "OPERATION", "STEPS", "SELECTION_RULE", "VisitSettings",
    "choose_visit", "eligible", "validate", "start", "resume", "run_operation",
]
