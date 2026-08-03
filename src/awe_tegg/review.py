"""The thing a coworker actually opens.

One Markdown file per site visit, written so the first screen answers the only
question they have -- *what do I need to price, and how urgent is it* -- and
every claim below it can be traced back to a page of a report they can open.

Three rules this file holds to:

  * **The draft banner is first, not last.** A person who reads only the top of
    the page must still know the money is a draft.
  * **Nothing is summarised away.** An item that could not be estimated appears
    in the same table as one that could, with the reason in place of the price.
  * **Every recommendation carries its citation.** "Standard IR Report, page 2A"
    is a place somebody can go and check; "the inspection found" is not.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .estimate import Estimate
from .findings import FindingSet
from .recommend import RecommendationSet

REVIEW_SCHEMA_VERSION = 1

URGENCY_LABEL = {
    "immediate": "IMMEDIATE",
    "high": "high",
    "scheduled": "scheduled",
    "monitor": "monitor",
    "closed": "closed on the visit",
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


def build(
    findings: FindingSet,
    recommendations: RecommendationSet,
    estimate: Estimate,
    *,
    run_id: str = "",
    evidence_dir: str = "",
) -> Review:
    lines: list[str] = []
    add = lines.append

    title = findings.site_visit or "site visit"
    add(f"# Site visit {title} — repair items for review")
    add("")
    add("> **DRAFT — NOT A QUOTATION, NOT AN APPROVAL.**")
    add("> Generated automatically from two TEGG inspection reports. Every line")
    add("> cites the page it came from. Nothing here has been sent to anyone,")
    add("> submitted to TEGG, or agreed with the customer. A qualified person")
    add("> must check every item before it is priced, scheduled or quoted.")
    if estimate.placeholder_rates:
        add(">")
        add("> **The money below is not real.** The rate card in use is marked")
        add("> `placeholder`, so every figure is illustrative only.")
    add("")

    # -- the answer, first --------------------------------------------------
    if findings.empty_reason:
        add("## Nothing to quote")
        add("")
        add("**This site visit recorded no equipment problems.** Both reports")
        add("were retrieved and both are empty of findings, so there is no")
        add("repair work to price.")
        add("")
        add(f"- evidence: {findings.empty_reason}")
        add("")
        add(_context_block(findings))
        add("")
        add("## Where this came from")
        add("")
        for document in findings.documents:
            add(f"- **{document['document']}** — `{document['filename']}`, "
                f"{document['bytes']:,} bytes, sha256 `{document['sha256'][:16]}…`")
        if run_id:
            add(f"- run id `{run_id}`")
        if evidence_dir:
            add(f"- the source PDFs are in `{evidence_dir}` — open them if you")
            add("  expected findings here")
        add("")
        return Review(
            markdown="\n".join(lines) + "\n",
            payload={
                "schema_version": REVIEW_SCHEMA_VERSION,
                "run_id": run_id,
                "findings": findings.to_dict(),
                "recommendations": recommendations.to_dict(),
                "estimate": estimate.to_dict(),
            },
        )

    open_items = [r for r in recommendations.recommendations if not r.already_corrected]
    urgent = [r for r in open_items if r.urgency in ("immediate", "high")]
    add("## What this comes to")
    add("")
    add(f"- **{len(open_items)}** item(s) still outstanding after the visit")
    add(f"- **{len(urgent)}** of those are immediate or high urgency")
    add(f"- **{len(estimate.priced_lines)}** could be given a rough size; "
        f"**{len(estimate.lines) - len(estimate.priced_lines)}** could not "
        f"(reasons in the table)")
    totals = estimate.totals()
    if estimate.priced_lines:
        status = " *(placeholder rates — not real money)*" if estimate.placeholder_rates else ""
        add(f"- rough range for the priced items: **{estimate.currency} "
            f"{totals['low']:,.0f} – {totals['high']:,.0f}** "
            f"(expected {estimate.currency} {totals['expected']:,.0f}){status}")
    add("")

    add(_context_block(findings))
    add("")

    # -- the table ----------------------------------------------------------
    add("## Items")
    add("")
    add("| Urgency | Tag | Equipment | Work | Outage | Rough range | Source |")
    add("|---|---|---|---|---|---|---|")
    by_id = {line.finding_id: line for line in estimate.lines}
    for recommendation in recommendations.recommendations:
        line = by_id.get(recommendation.finding_id)
        if line is not None and line.priced:
            money = (f"{estimate.currency} {line.total['low']:,.0f}–"
                     f"{line.total['high']:,.0f}")
        else:
            money = f"*not estimated — {(line.not_priced_reason if line else 'no line')}*"
        outage = {True: "yes", False: "no", None: "unknown"}[recommendation.requires_shutdown]
        source = _first_citation(recommendation.evidence)
        add(
            f"| {URGENCY_LABEL.get(recommendation.urgency, recommendation.urgency)} "
            f"| {recommendation.tag_id} "
            f"| {_cell(recommendation.equipment_type)} "
            f"| {recommendation.work_type or '*not stated*'} "
            f"| {outage} | {money} | {source} |"
        )
    add("")

    # -- one section per item ----------------------------------------------
    add("## Each item in full")
    add("")
    for recommendation in recommendations.recommendations:
        line = by_id.get(recommendation.finding_id)
        add(f"### {recommendation.tag_id} — {recommendation.equipment_type or 'equipment'}"
            f"  ({URGENCY_LABEL.get(recommendation.urgency, recommendation.urgency)})")
        add("")
        if recommendation.customer_id:
            add(f"- **customer's own id:** {recommendation.customer_id}")
        if recommendation.location:
            add(f"- **location:** {recommendation.location}")
        add(f"- **severity on the report:** {recommendation.severity or 'not stated'}")
        if recommendation.consequences:
            add(f"- **consequences if not corrected:** "
                f"{', '.join(recommendation.consequences)}")
        add(f"- **already corrected on the visit:** "
            f"{'yes' if recommendation.already_corrected else 'no'}")
        add(f"- **estimate required (per the report):** "
            f"{'yes' if recommendation.estimate_required else 'no'}")
        add("")
        if recommendation.problem_description:
            add(f"**Problem, as recorded:** {recommendation.problem_description}")
            add("")
        if recommendation.technician_recommendation:
            add("**Technician's recommendation, verbatim:**")
            add("")
            for text in recommendation.technician_recommendation:
                add(f"> {text}")
            add("")
        add("**Why this line says what it says:**")
        add("")
        for reason in recommendation.rationale:
            add(f"- {reason}")
        if line is not None and line.assumptions:
            for assumption in line.assumptions:
                add(f"- estimate: {assumption}")
        if line is not None and not line.priced:
            add(f"- **not estimated:** {line.not_priced_reason}")
        add("")
        if recommendation.warnings:
            add("**Needs a person to look at it:**")
            add("")
            for warning in recommendation.warnings:
                add(f"- {warning}")
            add("")
        add(f"**Source:** {_citations(recommendation.evidence)}")
        add("")

    # -- the small print, which is not small -------------------------------
    add("## Assumptions behind every number above")
    add("")
    for assumption in estimate.assumptions:
        add(f"- {assumption}")
    add("")
    add(f"Rate card: `{estimate.rate_card}`  ·  status: **{estimate.status}**")
    add("")

    warnings = list(dict.fromkeys(list(findings.warnings) + list(estimate.warnings)))
    add("## Anything the tool was not sure about")
    add("")
    if warnings:
        for warning in warnings:
            add(f"- {warning}")
    else:
        add("- nothing; every page parsed cleanly and every mark was accounted for")
    add("")

    add("## Where this came from")
    add("")
    for document in findings.documents:
        add(f"- **{document['document']}** — `{document['filename']}`, "
            f"{document['bytes']:,} bytes, sha256 `{document['sha256'][:16]}…`")
    if run_id:
        add(f"- run id `{run_id}`")
    if evidence_dir:
        add(f"- evidence and the source PDFs: `{evidence_dir}`")
    add("")
    add("## What this tool did NOT do")
    add("")
    add("- it did not submit, approve, email, upload or change anything in TEGG")
    add("- it did not contact the customer")
    add("- it did not price materials from a supplier")
    add("- it did not visit the site or verify any measurement")
    add("")

    payload = {
        "schema_version": REVIEW_SCHEMA_VERSION,
        "run_id": run_id,
        "findings": findings.to_dict(),
        "recommendations": recommendations.to_dict(),
        "estimate": estimate.to_dict(),
    }
    return Review(markdown="\n".join(lines) + "\n", payload=payload)


def _context_block(findings: FindingSet) -> str:
    rows = [
        ("customer", findings.customer),
        ("site", findings.site),
        ("site visit", findings.site_visit),
        ("agreement", findings.agreement),
        ("contractor", findings.contractor),
    ]
    lines = ["## The visit", ""]
    for name, value in rows:
        if value:
            lines.append(f"- **{name}:** {value}")
    return "\n".join(lines)


def _first_citation(evidence: list[dict[str, Any]]) -> str:
    if not evidence:
        return "*none*"
    first = evidence[0]
    return f"p.{first.get('page_label') or first.get('page')}"


def _citations(evidence: list[dict[str, Any]]) -> str:
    if not evidence:
        return "*no source recorded — do not rely on this line*"
    return "; ".join(
        f"{item.get('document', '?')}, page {item.get('page_label') or item.get('page')}"
        f" (sha256 {str(item.get('sha256', ''))[:12]}…)"
        for item in evidence
    )


def _cell(value: str) -> str:
    return (value or "").replace("|", "\\|")
