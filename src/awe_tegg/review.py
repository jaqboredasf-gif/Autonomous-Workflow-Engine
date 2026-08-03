"""The thing a coworker actually opens.

One Markdown file per site visit, written so the first screen answers the only
question they have -- *what needs doing, how urgent is it, and roughly what
does it involve* -- and every claim below it can be traced back to a page of a
report they can open.

Four rules this file holds to:

  * **The draft banner is first, not last.** Somebody who reads only the top of
    the page must still know the money is a draft.
  * **Nothing is summarised away.** An item that could not be priced appears in
    the same table as one that could, with the reason in place of the number.
  * **Every recommendation carries its citation.** "Standard IR Report, page 2A"
    is a place somebody can go and check; "the inspection found" is not.
  * **Confidence is never a bare word.** A reader who is told "medium" and
    nothing else has learned nothing they can act on.

This module renders; it decides nothing. Everything it shows was computed by
:mod:`awe_estimating` and can be recomputed from the JSON beside it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from awe_estimating import Estimate, ScopeItem, to_cents
from awe_estimating.confidence import ConfidenceReport

from .findings import FindingSet
from .recommend import RecommendationSet

REVIEW_SCHEMA_VERSION = 2

URGENCY_LABEL = {
    "immediate": "IMMEDIATE",
    "high": "high",
    "scheduled": "scheduled",
    "monitor": "monitor",
    "closed": "closed on the visit",
}

CONFIDENCE_LABEL = {
    "high": "HIGH",
    "medium": "medium",
    "low": "LOW — read the reasons before quoting anything",
    "insufficient": "NOT ENOUGH TO GO ON — this is not a usable estimate",
}


@dataclass
class Review:
    """The generated result set: one Markdown page and the data behind it."""

    markdown: str = ""
    payload: dict[str, Any] | None = None

    def write(self, directory: Path, stem: str = "review") -> dict[str, Path]:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        md = directory / f"{stem}.md"
        js = directory / f"{stem}.json"
        md.write_text(self.markdown, encoding="utf-8")
        js.write_text(
            json.dumps(self.payload or {}, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return {"markdown": md, "json": js}


def _placeholder(estimate: Estimate) -> bool:
    return any("template" in w for w in estimate.warnings)


def _amount(estimate: Estimate, value: Decimal) -> str:
    return f"{estimate.currency} {to_cents(value):,.0f}"


def build(
    findings: FindingSet,
    recommendations: RecommendationSet,
    estimate: Estimate,
    confidence: ConfidenceReport | None = None,
    *,
    run_id: str = "",
    evidence_dir: str = "",
) -> Review:
    lines: list[str] = []
    add = lines.append
    placeholder = _placeholder(estimate)

    title = findings.site_visit or estimate.source_reference or "site visit"
    add(f"# Site visit {title} — repair items for review")
    add("")
    add("> **DRAFT — NOT A QUOTATION, NOT AN APPROVAL.**")
    add("> Generated automatically from two TEGG inspection reports. Every line")
    add("> cites the page it came from. Nothing here has been sent to anyone,")
    add("> submitted to TEGG, or agreed with the customer. A qualified person")
    add("> must check every item before it is priced, scheduled or quoted.")
    if placeholder:
        add(">")
        add("> **The money below is not real.** The rate card in use is marked")
        add("> `placeholder`, so every figure is illustrative only.")
    add("")

    if findings.empty_reason:
        return _nothing_to_quote(
            lines, findings, recommendations, estimate, run_id, evidence_dir
        )

    # -- the answer, first --------------------------------------------------
    work = estimate.work_scope
    outstanding = [i for i in work if not i.excluded_reason]
    urgent = [i for i in outstanding if i.urgency in ("immediate", "high")]
    priced = [i for i in outstanding if i.priceable]

    add("## What this comes to")
    add("")
    add(f"- **{len(outstanding)}** item(s) still outstanding after the visit")
    add(f"- **{len(urgent)}** of those are immediate or high urgency")
    add(f"- **{len(priced)}** could be priced; "
        f"**{len(outstanding) - len(priced)}** could not "
        f"(the reason is on each row)")
    if priced:
        low, base, high = estimate.range
        status = " *(placeholder rates — not real money)*" if placeholder else ""
        add(f"- rough range: **{_amount(estimate, low)} – "
            f"{_amount(estimate, high)}** "
            f"(expected {_amount(estimate, base)}){status}")
    add("")

    # -- confidence, with its reasons --------------------------------------
    if confidence is not None:
        label = CONFIDENCE_LABEL.get(confidence.level.value, confidence.level.value)
        add(f"## How much to trust this: **{label}**")
        add("")
        for reason in confidence.reasons:
            add(f"- {reason}")
        add("")

    add(_context_block(findings, estimate))
    add("")

    # -- the table ----------------------------------------------------------
    add("## Items")
    add("")
    add("| Urgency | Tag | Equipment | Work | Outage | Rough cost | Source |")
    add("|---|---|---|---|---|---|---|")
    for item in sorted(work, key=_row_order):
        if item.ancillary:
            continue
        add(_row(item, estimate))
    add("")

    ancillary = [i for i in estimate.scope if i.ancillary and i.priceable]
    if ancillary:
        add("Plus, once per visit:")
        add("")
        for item in ancillary:
            add(f"- {item.issue or item.scope_id}: "
                f"{_amount(estimate, item.subtotal())}")
        add("")

    # -- how the total is built --------------------------------------------
    if priced:
        add("## How the total is built")
        add("")
        add("| | amount |")
        add("|---|---:|")
        add(f"| direct cost | {_amount(estimate, estimate.subtotal)} |")
        for adjustment, base, amount in estimate.applied_adjustments():
            label = adjustment.label or adjustment.kind.value
            add(f"| {label} ({adjustment.rate:.2%} of "
                f"{_amount(estimate, base)}) | {_amount(estimate, amount)} |")
        add(f"| **total** | **{_amount(estimate, estimate.total)}** |")
        add("")
        add(f"Priced from `{estimate.pricing_source}`.")
        add("")

    # -- one section per item ----------------------------------------------
    add("## Each item in full")
    add("")
    for item in sorted(work, key=_row_order):
        if item.ancillary:
            continue
        lines.extend(_item_detail(item, estimate))

    # -- open questions -----------------------------------------------------
    questions = estimate.open_questions
    add("## Questions that need answering")
    add("")
    if questions:
        add("Each of these was asked instead of guessing. The ones marked")
        add("**blocking** are why an item has no price.")
        add("")
        for question in questions:
            mark = "**blocking** — " if question.blocks_pricing else ""
            about = f" *(item {question.about})*" if question.about else ""
            add(f"- {mark}{question.question}{about}")
            if question.why_it_matters:
                add(f"  - why it matters: {question.why_it_matters}")
        add("")
    else:
        add("- none; nothing had to be guessed at")
        add("")

    # -- assumptions and exclusions ----------------------------------------
    add("## Assumptions behind every number above")
    add("")
    seen: set[str] = set()
    for assumption in _all_assumptions(estimate):
        if assumption.text in seen:
            continue
        seen.add(assumption.text)
        flag = " **(needs confirming)**" if not assumption.provenance.may_price else ""
        add(f"- {assumption.text}{flag}  \n  *{assumption.provenance.cite()}*")
    if not seen:
        add("- none recorded")
    add("")

    if estimate.exclusions:
        add("## Not included in the price")
        add("")
        for exclusion in estimate.exclusions:
            add(f"- {exclusion.text}")
        add("")

    if recommendations.policy:
        add("## The judgement calls in force for this run")
        add("")
        add("Urgency, what counts as a safety matter, and what wording means an")
        add("outage are decisions, not facts. If they are wrong for your")
        add("business, they are settings — see `policy:` in `config/service.yaml`.")
        add("")
        for line in recommendations.policy:
            add(f"- {line}")
        add("")

    warnings = list(dict.fromkeys(list(findings.warnings) + list(estimate.warnings)))
    add("## Anything the tool was not sure about")
    add("")
    for warning in warnings or ["nothing; every page parsed cleanly"]:
        add(f"- {warning}")
    add("")

    lines.extend(_provenance_block(findings, run_id, evidence_dir))

    payload = {
        "schema_version": REVIEW_SCHEMA_VERSION,
        "run_id": run_id,
        "findings": findings.to_dict(),
        "recommendations": recommendations.to_dict(),
        "estimate": estimate.to_dict(),
        "confidence": confidence.to_dict() if confidence else None,
    }
    return Review(markdown="\n".join(lines) + "\n", payload=payload)


# -- pieces ----------------------------------------------------------------


def _row_order(item: ScopeItem) -> tuple[int, str]:
    order = ["immediate", "high", "scheduled", "monitor", "closed", ""]
    urgency = item.urgency if item.urgency in order else ""
    return (order.index(urgency), item.asset_id or item.scope_id)


def _row(item: ScopeItem, estimate: Estimate) -> str:
    if item.priceable:
        cost = _amount(estimate, item.subtotal())
    elif item.excluded_reason:
        cost = f"*not priced — {item.excluded_reason}*"
    else:
        cost = "*not priced — see the questions below*"
    outage = "yes" if any("outage" in c or "shutdown" in c
                          for c in item.access_constraints) else "no"
    return (
        f"| {URGENCY_LABEL.get(item.urgency, item.urgency or '—')} "
        f"| {item.asset_id} | {_cell(item.asset_type)} "
        f"| {item.work_type or '*not stated*'} | {outage} | {cost} "
        f"| {_first_citation(item)} |"
    )


def _item_detail(item: ScopeItem, estimate: Estimate) -> list[str]:
    out: list[str] = []
    add = out.append
    add(f"### {item.asset_id or item.scope_id} — "
        f"{item.asset_type or 'equipment'}  "
        f"({URGENCY_LABEL.get(item.urgency, item.urgency or 'not graded')})")
    add("")
    if item.location:
        add(f"- **location:** {item.location}")
    add(f"- **work:** {item.work_type or '*the report does not say*'}")
    add(f"- **outstanding:** {'no — ' + item.excluded_reason if item.excluded_reason else 'yes'}")
    add("")
    if item.issue:
        add(f"**Problem, as recorded:** {item.issue}")
        add("")
    if item.recommended_work:
        add("**Technician's recommendation, verbatim:**")
        add("")
        add(f"> {item.recommended_work}")
        add("")

    if item.lines:
        add("| | quantity | rate | amount | from |")
        add("|---|---:|---:|---:|---|")
        for line in item.lines:
            amount = _amount(estimate, line.total) if line.priceable else "*—*"
            add(f"| {line.description or line.kind.value} "
                f"| {line.quantity} {line.unit} "
                f"| {to_cents(line.unit_cost):,} "
                f"| {amount} | `{line.rate_provenance.locator}` |")
        add("")
    if not item.priceable and not item.excluded_reason:
        add("**Not priced.** " + "; ".join(item.blocked_by))
        add("")
    add(f"**Source:** {_citations(item)}")
    add("")
    return out


def _nothing_to_quote(lines, findings, recommendations, estimate, run_id, evidence_dir):
    add = lines.append
    add("## Nothing to quote")
    add("")
    add("**This site visit recorded no equipment problems.** Both reports were")
    add("retrieved and both are empty of findings, so there is no repair work")
    add("to price.")
    add("")
    add(f"- evidence: {findings.empty_reason}")
    add("")
    add(_context_block(findings, estimate))
    add("")
    lines.extend(_provenance_block(findings, run_id, evidence_dir))
    return Review(
        markdown="\n".join(lines) + "\n",
        payload={
            "schema_version": REVIEW_SCHEMA_VERSION,
            "run_id": run_id,
            "findings": findings.to_dict(),
            "recommendations": recommendations.to_dict(),
            "estimate": estimate.to_dict(),
            "confidence": None,
        },
    )


def _all_assumptions(estimate: Estimate):
    for assumption in estimate.assumptions:
        yield assumption
    for item in estimate.scope:
        for assumption in item.assumptions:
            yield assumption


def _context_block(findings: FindingSet, estimate: Estimate) -> str:
    rows = [
        ("customer", findings.customer or estimate.customer),
        ("site", findings.site or estimate.site),
        ("site visit", findings.site_visit or estimate.source_reference),
        ("agreement", findings.agreement),
        ("contractor", findings.contractor),
    ]
    out = ["## The visit", ""]
    out += [f"- **{name}:** {value}" for name, value in rows if value]
    return "\n".join(out)


def _provenance_block(findings: FindingSet, run_id: str, evidence_dir: str) -> list[str]:
    out = ["## Where this came from", ""]
    for document in findings.documents:
        out.append(f"- **{document['document']}** — `{document['filename']}`, "
                   f"{document['bytes']:,} bytes, sha256 "
                   f"`{document['sha256'][:16]}…`")
    if run_id:
        out.append(f"- run id `{run_id}`")
    if evidence_dir:
        out.append(f"- evidence and the source PDFs: `{evidence_dir}`")
    out += [
        "",
        "## What this tool did NOT do",
        "",
        "- it did not submit, approve, email, upload or change anything in TEGG",
        "- it did not contact the customer",
        "- it did not price materials from a supplier",
        "- it did not visit the site or verify any measurement",
        "",
    ]
    return out


def _first_citation(item: ScopeItem) -> str:
    if not item.evidence:
        return "*none*"
    locator = item.evidence[0].locator
    return locator.split(", ")[-1] if ", " in locator else locator


def _citations(item: ScopeItem) -> str:
    if not item.evidence:
        return "*no source recorded — do not rely on this line*"
    return "; ".join(e.cite() for e in item.evidence[:3])


def _cell(value: str) -> str:
    return (value or "").replace("|", "\\|")
