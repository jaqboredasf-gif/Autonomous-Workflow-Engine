"""The second operation: one completed site visit, read end to end.

    ask the operator what this report is -> sign in -> reach Documentation ->
    choose the completed visit -> put the portal in that site's context ->
    assemble the package (see below) -> read the findings out of two of the
    documents -> recommend -> estimate -> validate -> write something a
    coworker can review -> draft an email nobody has sent

## The package

Eight documents, from three different places, all named in
:mod:`awe_tegg.deliverables`:

  * the **Table of Contents** is copied from ``assets/static``;
  * the **Certificate** comes from the Document Library tab, by Solution,
    and arrives as a ``.doc`` that has to be converted;
  * **six Standard ESA Reports** are rendered by SSRS and exported as PDF.

Nothing is reported as finished unless all eight are present, valid, distinct
and correctly filed. See :meth:`deliverables.Manifest.enforce`.

Read-only with respect to TEGG by default. Rendering a report is a read: the
documents are built from data that is already there, and no TEGG record is
created, changed, submitted, approved or sent unless the run was explicitly
armed to do so -- see :mod:`awe_tegg.portal_write`, which is off unless asked
for on the command line *and* confirmed at the keyboard.

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

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from awe_knowledge.models import KnowledgeError
from awe_runtime import workspace_root as root_module

from . import documents as documents_module
from awe_estimating import price as price_scope
from awe_estimating.confidence import ConfidenceRules, apply as apply_confidence
from awe_estimating.ratecard import RateCard, RateCardError, validate_for_production

from . import deliverables as deliverables_module
from . import email_draft as email_module
from . import findings as findings_module
from . import intake as intake_module
from . import markers as marker_module
from . import portal_write
from . import recommend as recommend_module
from . import review as review_module
from . import scope_adapter
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
    "create_tegg_report",
    "extract_findings",
    "recommend_repairs",
    "build_estimate",
    "validate_result",
    "publish_review",
    "check_deliverables",
    "draft_email",
    "finish",
)

#: Steps that need a live browser. A resume re-establishes these rather than
#: skipping them; everything else after the last durable checkpoint is redone.
PRECONDITION_STEPS = frozenset({"sign_in", "locate_workspace", "reach_documentation"})

#: Steps that produce a durable artefact and are therefore skippable on resume
#: *if* the artefact is still there and still matches its recorded checksum.
DURABLE_STEPS = frozenset({"retrieve_documents"})

DEFAULT_RATE_CARD = Path("config/ratecard.example.yaml")


@dataclass
class VisitSettings:
    """Everything ``visit-findings`` needs beyond the shared portal settings."""

    site_visit: str = ""
    rate_card: Path = DEFAULT_RATE_CARD
    #: Six SSRS renders plus a Document Library fetch, not two. Each render is
    #: a form, a Print Report, a viewer and an export, so the budget has to
    #: cover roughly three and a half times what two reports needed.
    retrieval_actions: int = 110
    retrieval_seconds: float = 2700.0
    include_corrected: bool = False
    #: The operator's confirmed answers. Never carries a credential.
    intake: intake_module.Intake | None = None
    #: Off unless the command line asked for it *and* a person confirmed.
    write_policy: portal_write.WritePolicy = field(
        default_factory=portal_write.WritePolicy
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "site_visit": self.site_visit,
            "rate_card": str(self.rate_card),
            "retrieval_actions": self.retrieval_actions,
            "retrieval_seconds": self.retrieval_seconds,
            "include_corrected": self.include_corrected,
            "intake": self.intake.to_dict() if self.intake else {},
            "write_enabled": self.write_policy.enabled,
            "write_confirmed": self.write_policy.confirmed,
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

    # A resume must not re-ask nine questions, and must not quietly answer
    # them differently: the intake belongs to the run, so it comes back off
    # the ledger when this attempt was not given one.
    operator = visit_settings.intake or intake_module.Intake.from_dict(
        ledger.data.get("intake") or {"site_visit": visit_settings.site_visit}
    )
    ledger.data["intake"] = operator.to_dict()

    reusable = _reusable_documents(ledger, documents_dir)
    if reusable:
        ledger.note(
            f"{len(reusable)} report(s) were already retrieved by this run and "
            "their checksums still match, so the portal was not asked for them "
            "again"
        )

    visit: dict[str, Any] = dict(ledger.data.get("visit") or {})
    retrieved: dict[str, Any] = dict(reusable)
    manifest = deliverables_module.Manifest.create(
        str(visit.get("identifier", "") or operator.site_visit)
    )

    def show(entry: deliverables_module.Entry) -> None:
        if on_step is None:
            return
        state = "OK" if entry.ok else entry.status.upper()
        on_step(
            f"        {state:<9} {entry.canonical_name} "
            f"({entry.generated_filename or entry.expected_filename})"
        )

    # A resume that already holds every portal document must not sign in. The
    # Table of Contents is not counted: it is a local copy, remade every time,
    # and needing the portal for it would be absurd.
    complete_already = all(
        item.key in reusable for item in deliverables_module.PORTAL_REQUIRED
    )

    if not complete_already or not visit:
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
                # The visit ID the operator typed at the intake screen is the
                # authority. Falling back to the standing rule when they gave
                # one would silently report on a different customer.
                wanted = visit_settings.site_visit or operator.site_visit
                visit, why = choose_visit(listing["records"], wanted)
                ledger.data["visit"] = visit
                manifest = deliverables_module.Manifest.create(
                    str(visit.get("identifier", "") or wanted)
                )
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
                # Three sources, in package order, each with its own mechanism.
                show(stage_table_of_contents(manifest, documents_dir))

                certificate = reusable.get("certificate")
                if certificate:
                    show(manifest.record(
                        "certificate", Path(certificate["path"]),
                        status=deliverables_module.REUSED,
                        sha256=str(certificate.get("sha256", "")),
                    ))
                else:
                    entry = retrieve_certificate(
                        reports, visit, manifest, documents_dir / "converted"
                    )
                    show(entry)
                    if entry.ok:
                        certificate = {"path": entry.location,
                                       "sha256": entry.sha256}

                retrieved = _retrieve(
                    reports, visit, ledger, manifest,
                    already=reusable, on_document=show,
                )
                if certificate:
                    retrieved["certificate"] = certificate
                ledger.checkpoint(
                    "retrieve_documents",
                    f"{len(manifest.produced)} of "
                    f"{deliverables_module.REQUIRED_COUNT} document(s) produced",
                    documents=retrieved,
                    manifest=manifest.to_dict(),
                    budget=retrieval_budget.to_dict(),
                )

                announce("create_tegg_report")
                outcome = _maybe_write(
                    explorer.page, visit_settings.write_policy, ledger
                )
                ledger.checkpoint(
                    "create_tegg_report", outcome["detail"], **outcome["data"]
                )
    else:
        # Every document was already on disk with a matching checksum, so the
        # portal is not contacted at all. The manifest is rebuilt from what is
        # there, so a resume still proves the set rather than assuming it.
        for step in ("open_knowledge", "sign_in", "locate_workspace",
                     "reach_documentation", "select_visit", "open_visit_context",
                     "retrieve_documents", "create_tegg_report"):
            announce(step)
        show(stage_table_of_contents(manifest, documents_dir))
        for key, record in reusable.items():
            if key in deliverables_module.BY_KEY:
                show(manifest.record(
                    key, Path(record["path"]),
                    status=deliverables_module.REUSED,
                    sha256=str(record.get("sha256", "")),
                ))

    # -- everything below is offline: no browser, no portal ----------------
    announce("extract_findings")
    finding_set = findings_module.build(
        equipment_item_problems=Path(
            retrieved[deliverables_module.FINDINGS_SOURCE]["path"]
        ),
        standard_ir=(
            Path(retrieved[deliverables_module.FINDINGS_CORROBORATION]["path"])
            if deliverables_module.FINDINGS_CORROBORATION in retrieved else None
        ),
        site_visit=str(visit.get("identifier", "")),
        # What the operator typed is what goes on the customer's report. The
        # portal's own spelling is kept in the ledger either way.
        customer=operator.customer or str(visit.get("customer", "")),
        site=operator.site or str(visit.get("site", "")),
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
        card = RateCard.load(visit_settings.rate_card)
    except RateCardError as error:
        ledger.escalate(str(error))
        raise Escalated(str(error)) from error

    scope_source = scope_adapter.from_recommendations(
        recommendations,
        customer=operator.customer or str(visit.get("customer", "")),
        site=operator.site or str(visit.get("site", "")),
        site_visit=str(visit.get("identifier", "")),
        include_corrected=visit_settings.include_corrected,
    )
    pricing = price_scope(
        scope_source, card,
        prepared_by="awe-tegg visit-findings",
        prepared_at=ledger.data.get("started_at", ""),
        estimate_id=ledger.run_id,
    )
    estimate = pricing.estimate
    confidence = apply_confidence(
        estimate, ConfidenceRules.from_mapping(
            settings.confidence_rules,
            source=("config/service.yaml" if settings.confidence_rules
                    else "built-in defaults (nobody has confirmed these)"),
        )
    )
    # A card that claims to be production is checked before its numbers are
    # believed. A template is allowed through -- it announces itself on every
    # page -- but a card asserting it is real and failing the check is not.
    if not card.placeholder:
        problems = validate_for_production(card)
        if problems:
            ledger.escalate(
                f"{visit_settings.rate_card} says it holds production rates but "
                "does not qualify: " + "; ".join(problems[:3])
            )
            raise Escalated("the rate card is not usable for real pricing")

    counts = estimate.to_dict()["counts"]
    ledger.checkpoint(
        "build_estimate",
        f"{counts['priced']} of {counts['scope_items']} item(s) priced; "
        f"confidence {confidence.level.value}",
        counts=counts,
        total=str(estimate.total),
        range={"low": str(estimate.range[0]), "high": str(estimate.range[2])},
        rate_card=str(visit_settings.rate_card),
        placeholder_rates=card.placeholder,
        confidence=confidence.to_dict(),
        unmatched_vocabulary=[list(u) for u in pricing.unmatched],
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
        finding_set, recommendations, estimate, confidence,
        run_id=ledger.run_id, evidence_dir=str(ledger.path),
    )
    written = result.write(ledger.path / "review")
    ledger.data["review"] = {k: str(v) for k, v in written.items()}
    ledger.checkpoint(
        "publish_review",
        f"written to {written['markdown']}",
        **{k: str(v) for k, v in written.items()},
    )

    # -- the package, and whether it is one --------------------------------
    announce("check_deliverables")
    manifest.add_additional("Review page", written["markdown"], source="generated")
    manifest.add_additional("Review data", written["json"], source="generated")
    manifest_path = manifest.write(ledger.path)
    ledger.data["deliverables"] = manifest.to_dict()
    ledger.data["manifest_path"] = str(manifest_path)

    try:
        manifest.enforce()
    except deliverables_module.DeliverableError as short:
        # This is the defect the mock run exposed, closed. A package with
        # a short package is never reported as a success, and the
        # run says exactly which are missing and why.
        ledger.escalate(str(short))
        raise Escalated(str(short)) from short

    ledger.checkpoint(
        "check_deliverables",
        f"all {deliverables_module.REQUIRED_COUNT} required documents present "
        "and valid",
        manifest=str(manifest_path),
        documents=manifest.filenames(),
    )

    announce("draft_email")
    if not operator.recipient_email:
        ledger.note(
            "no recipient was given at the intake screen, so no email draft "
            "was written. The documents are in the folder above."
        )
        ledger.checkpoint("draft_email", "skipped: no recipient given", drafted=False)
    else:
        draft = email_module.build(
            operator, manifest,
            review_note=(
                "Generated automatically and NOT sent. A person must read this "
                f"and press Send. Review page: {written['markdown']}"
            ),
            year=str(visit.get("end_date", "") or "")[-4:],
        )
        draft = email_module.write(draft, ledger.path / "email")
        ledger.data["email_draft"] = draft.to_dict()
        ledger.checkpoint(
            "draft_email",
            f"draft written for {draft.to_email}; NOT sent",
            **draft.to_dict(),
        )

    announce("finish")
    ledger.checkpoint(
        "finish",
        "finished; the email was drafted and NOT sent, and nothing was "
        "submitted or approved in TEGG",
    )
    ledger.complete()
    return result_from(ledger)


def _maybe_write(
    page: Any,
    policy: portal_write.WritePolicy,
    ledger: RunLedger,
) -> dict[str, Any]:
    """Create or update the TEGG report record, if and only if fully armed.

    The default path through this function clicks nothing. It exists so that
    "did this run write to TEGG?" is answered explicitly in every ledger,
    rather than being inferred from the absence of a step.
    """
    if not policy.armed:
        return {
            "detail": policy.describe(),
            "data": {"wrote": False, "reason": policy.describe()},
        }
    try:
        outcome = portal_write.create_or_update(
            page, policy, on_note=ledger.note
        )
    except (portal_write.WriteRefused, portal_write.WriteNotConfigured) as error:
        # A refused write is not a failed run: the documents are still
        # the useful output, and the operator is told plainly what did not
        # happen. Escalating records it where they will actually read it.
        ledger.escalate(f"the TEGG report record was NOT created: {error}")
        return {
            "detail": f"refused: {error}",
            "data": {"wrote": False, "reason": str(error)},
        }
    ledger.data.setdefault("external_changes", []).extend(policy.actions)
    return {
        "detail": "a report record was created or updated in TEGG",
        "data": outcome,
    }


def stage_table_of_contents(
    manifest: deliverables_module.Manifest,
    destination: Path,
    *,
    assets_dir: Path | None = None,
) -> deliverables_module.Entry:
    """Copy the Table of Contents into the package.

    It is a static file that ships with the tool -- not fetched from TEGG, not
    generated. ``assets/static/ESA Table of Contents.pdf``.

    Open question, recorded in ``assets/static/README.md`` and GAPS #8 and not
    resolved here: whether the contents page is genuinely identical for every
    report or varies with report length. If it varies it has to be generated
    per job, and this function becomes wrong -- but it will be wrong loudly,
    because the same file will appear in every package.
    """
    expected = deliverables_module.BY_KEY["table_of_contents"]
    assets_dir = Path(assets_dir or root_module.resolve("assets/static"))
    source = assets_dir / expected.static_source
    if not source.exists():
        return manifest.fail(
            expected.key,
            f"the static Table of Contents is not at {source}. It ships with "
            "the tool; if it is missing the package cannot be assembled.",
        )
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / expected.filename(manifest.site_visit)
    shutil.copy2(source, target)
    return manifest.record(
        expected.key, target,
        status=deliverables_module.COPIED,
        sha256=findings_module.checksum(target),
    )


def retrieve_certificate(
    reports: documents_module.ReportRun,
    visit: dict[str, Any],
    manifest: deliverables_module.Manifest,
    work_dir: Path,
) -> deliverables_module.Entry:
    """Fetch the certificate from the Document Library and convert it to PDF.

    Two steps that fail for unrelated reasons, so they are reported
    separately: the portal may not hand the file over (which it did not in the
    2026-07-29 dry run), and the conversion needs LibreOffice, which a
    coworker's PC may simply not have.
    """
    from tegg import certdoc
    from tegg.certificate import CertificateError

    expected = deliverables_module.BY_KEY["certificate"]
    agreement = str(visit.get("agreement", ""))
    raw_name = f"{manifest.site_visit or 'visit'}-Certificate.doc"

    try:
        got = reports.retrieve_certificate(agreement=agreement, filename=raw_name)
    except RetrievalError as error:
        return manifest.fail(expected.key, str(error))

    source = Path(got.path)
    if source.suffix.lower() == ".pdf":
        return manifest.record(
            expected.key, source,
            status=deliverables_module.GENERATED,
            sha256=findings_module.checksum(source),
        )

    try:
        outcome = certdoc.prepare(
            source, Path(work_dir),
            output_pdf_name=expected.filename(manifest.site_visit),
        )
    except CertificateError as error:
        return manifest.fail(
            expected.key,
            f"the certificate arrived as {source.name} but could not be "
            f"converted to PDF: {error}. Converting a .doc needs LibreOffice "
            "on this PC.",
        )
    if outcome.pdf is None or not Path(outcome.pdf).exists():
        return manifest.fail(
            expected.key,
            f"the certificate arrived as {source.name} and the conversion "
            "produced no PDF",
        )
    return manifest.record(
        expected.key, Path(outcome.pdf),
        status=deliverables_module.CONVERTED,
        sha256=findings_module.checksum(Path(outcome.pdf)),
    )


def _retrieve(
    reports: documents_module.ReportRun,
    visit: dict[str, Any],
    ledger: RunLedger,
    manifest: deliverables_module.Manifest,
    *,
    already: dict[str, Any] | None = None,
    on_document: Callable[[deliverables_module.Entry], None] | None = None,
) -> dict[str, Any]:
    """The six Standard ESA Reports, recorded into the manifest as they land.

    The Table of Contents and the Certificate are NOT here. They come from
    different places -- a shipped static file and the Document Library -- and
    each is produced by its own function, because sharing one loop across
    three mechanisms is how a route gets applied to the wrong document.

    One report failing does not abandon the rest: the operator is better served
    by "seven of eight, and here is which one and why" than by a run that stops
    at the first refusal and tells them nothing about the others. The shortfall
    is enforced later, by :meth:`Manifest.enforce`, which is the only place
    that decides whether the package is publishable.

    ``already`` carries documents an earlier attempt produced and whose
    checksums still match, so a resume re-renders only what is genuinely
    missing. Re-rendering a customer's reports because a laptop lid closed is
    neither free nor polite.
    """
    agreement = str(visit.get("agreement", ""))
    identifier = str(visit.get("identifier", "visit"))
    already = dict(already or {})
    out: dict[str, Any] = {}
    failures: list[str] = []

    esa_reports = [
        item for item in deliverables_module.REQUIRED
        if item.source == deliverables_module.FROM_ESA_REPORT
    ]

    for expected in esa_reports:
        filename = expected.filename(identifier)

        reused = already.get(expected.key)
        if reused:
            record = dict(reused)
            entry = manifest.record(
                expected.key, Path(record["path"]),
                status=deliverables_module.REUSED,
                sha256=str(record.get("sha256", "")),
            )
            out[expected.key] = record
            if on_document is not None:
                on_document(entry)
            continue

        try:
            got = reports.retrieve(
                expected.canonical_name, expected.route,
                agreement=agreement, filename=filename,
            )
        except RetrievalError as error:
            failures.append(f"{expected.canonical_name}: {error}")
            entry = manifest.fail(expected.key, str(error))
            if on_document is not None:
                on_document(entry)
            continue

        record = got.to_dict()
        record["sha256"] = findings_module.checksum(Path(got.path))
        entry = manifest.record(
            expected.key, Path(got.path),
            status=deliverables_module.GENERATED,
            sha256=record["sha256"],
        )
        # A file that arrived but did not validate is not a document. Keeping
        # it as "generated" would let an empty SSRS render reach a customer.
        if not entry.ok:
            failures.append(f"{expected.canonical_name}: {entry.detail}")
        else:
            out[expected.key] = record
        if on_document is not None:
            on_document(entry)

    # The findings parser reads this one. Its absence is fatal here, earlier
    # and for a different reason than the package merely being short.
    if deliverables_module.FINDINGS_SOURCE not in out:
        detail = "; ".join(failures) or "no reason recorded"
        ledger.escalate(
            "the Equipment Item Problems Report could not be retrieved, and it "
            f"is what the findings are read from: {detail}"
        )
        raise Escalated(detail)
    if failures:
        ledger.note(
            f"{len(failures)} of {len(esa_reports)} Standard ESA Report(s) did "
            "not come back: " + "; ".join(failures)
        )
    return out


def _reusable_documents(ledger: RunLedger, directory: Path) -> dict[str, Any]:
    """Documents an earlier attempt fetched, if they are still exactly those.

    Checked by checksum rather than by existence. A file that changed under us
    is not the file the ledger is talking about, and re-fetching is cheaper
    than being wrong about which customer's report is on disk.

    Returns whatever still holds, per document, rather than all-or-nothing: a
    resume that lost one report should re-render that one, not all of them.
    """
    for entry in reversed(ledger.data.get("steps", [])):
        if entry.get("step") != "retrieve_documents":
            continue
        recorded = (entry.get("data") or {}).get("documents") or {}
        out: dict[str, Any] = {}
        for key, record in recorded.items():
            path = Path(record.get("path", ""))
            if not path.exists():
                continue
            if record.get("sha256") and findings_module.checksum(path) != record["sha256"]:
                continue
            out[key] = record
        return out
    return {}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate(
    finding_set: findings_module.FindingSet,
    recommendations: recommend_module.RecommendationSet,
    estimate: Any,
) -> dict[str, list[str]]:
    """Check the result against itself before anyone is shown it.

    ``fatal`` stops the run. ``advisory`` is printed and carried into the
    review, because a coworker who is told what the tool was unsure about can
    do something about it, and one who is not, cannot.

    The checks are about *internal consistency*, not about whether the numbers
    are right -- nothing here can know that. They catch the class of fault
    where the pipeline lost or duplicated something between stages, which is
    invisible in the output and fatal to trust.
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

    work_scope = [i for i in estimate.work_scope]
    if len(work_scope) != len(recommendations.recommendations):
        fatal.append(
            f"{len(recommendations.recommendations)} recommendation(s) produced "
            f"{len(work_scope)} scope item(s); nothing may be lost crossing "
            "into estimating"
        )

    for recommendation in recommendations.recommendations:
        if not recommendation.evidence:
            fatal.append(f"{recommendation.finding_id} carries no source citation")
        if not recommendation.review_required:
            fatal.append(
                f"{recommendation.finding_id} is not marked as needing review"
            )

    for item in estimate.scope:
        if item.priceable and not item.evidence and not item.ancillary:
            fatal.append(f"{item.scope_id} is priced but cites no source")
        for line in item.lines:
            if line.priceable and line.total < 0:
                fatal.append(f"{item.scope_id}: a negative amount")

    low, base, high = estimate.range
    if not (low <= base <= high):
        fatal.append("the estimate range is not ordered")

    placeholder = any("template" in w for w in estimate.warnings)
    if placeholder and estimate.approval.status.value == "approved":
        fatal.append(
            "an estimate built on template rates cannot be approved"
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
            "and could not be priced"
        )
    if placeholder:
        advisory.append(
            "the rate card is a template, so no figure in this result is money"
        )
    blocking = [q for q in estimate.open_questions if q.blocks_pricing]
    if blocking:
        advisory.append(
            f"{len(blocking)} question(s) must be answered before every item "
            "can be priced"
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

    package = data.get("deliverables") or {}
    if package:
        notes.append(
            f"documents: {package.get('produced', 0)} of "
            f"{package.get('required', deliverables_module.REQUIRED_COUNT)} required"
        )
    draft = data.get("email_draft") or {}
    if draft:
        notes.append(
            f"email draft for {draft.get('to_email', '')} written to "
            f"{draft.get('path', '')} -- NOT sent"
        )
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
    except (OperationError, KnowledgeError, RetrievalError, RateCardError,
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
