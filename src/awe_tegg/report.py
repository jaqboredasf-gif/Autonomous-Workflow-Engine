"""The operator's answer, in the ten lines they actually need.

Written for somebody who did not build this and will not read the code: what
ran, how far it got, what it found, what it changed its mind about, and what --
if anything -- it needs a human for. Every line is either a fact from the ledger
or absent.

Two things it will not do. It will not print a credential, because it never has
one: the run records the *name* of the environment variable and nothing else. And
it will not report a success it cannot show, so "records found" comes from the
list that was actually captured, and "corrected knowledge" is empty unless a
record really was written.
"""

from __future__ import annotations

import json
from typing import Any

from .checkpoint import COMPLETED, ESCALATED, FAILED, INTERRUPTED, STEPS
from .operation import OperationResult

#: What each status means to the person reading it, in one line.
STATUS_MEANING = {
    COMPLETED: "finished, read-only, nothing left to do",
    ESCALATED: "stopped on purpose and needs a person",
    INTERRUPTED: "stopped part-way; safe to resume",
    FAILED: "could not continue; see 'human action required'",
    "running": "still going, or the process died without saying so",
}


def _bullets(items: list[str], empty: str = "none") -> list[str]:
    return [f"    {line}" for line in items] if items else [f"    {empty}"]


def render(result: OperationResult, *, limit: int = 15) -> str:
    """The operator block. Same ten headings every time, present or empty."""
    lines: list[str] = []
    lines.append(f"run id                  {result.run_id}")
    lines.append(
        f"status                  {result.status}"
        f"  ({STATUS_MEANING.get(result.status, '')})"
    )

    done = result.steps_completed
    lines.append(f"steps completed         {len(done)}/{len(STEPS)}")
    for step in STEPS:
        mark = "done" if step in done else "  --"
        lines.append(f"    {mark}  {step}")

    lines.append("")
    lines.append(f"records found           {len(result.records)}")
    if result.pages_read:
        lines.append(
            f"    read from {result.pages_read} page(s) of the documentation "
            f"list ({result.rows_on_first_page} row(s) per page)"
        )
    for record in result.records[:limit]:
        lines.append(f"    {_record_line(record)}")
    if len(result.records) > limit:
        lines.append(f"    ... and {len(result.records) - limit} more "
                     f"(all of them are in the run folder)")

    lines.append("")
    lines.append("knowledge used")
    lines.extend(_bullets([
        f"{k.get('record_id', '?')}  v{k.get('version', '?')}  "
        f"({k.get('trust', '?')})"
        for k in result.knowledge_used
    ], "none -- this run worked everything out from scratch"))

    lines.append("")
    lines.append("stale knowledge detected")
    lines.extend(_bullets([
        f"{s.get('record_id', '?')}  v{s.get('version', '?')}  "
        f"{s.get('trust_before', '?')} -> {s.get('trust_after', '?')}"
        for s in result.stale_knowledge
    ], "none -- everything the run believed still held"))
    for contradiction in result.contradictions:
        lines.append(f"    why: {contradiction.get('reason', '')}")

    lines.append("")
    lines.append("corrected knowledge created")
    lines.extend(_bullets([
        f"{c.get('record_id', '?')}  v{c.get('version', '?')}  "
        f"({c.get('trust', '?')})"
        + (f"  supersedes {c['supersedes']}" if c.get("supersedes") else "")
        for c in result.corrected_knowledge
    ], "none -- nothing needed correcting"))

    lines.append("")
    lines.append("human action required")
    lines.extend(_bullets(result.human_action_required, "none"))

    lines.append("")
    lines.append("external changes performed")
    lines.extend(_bullets([
        f"{c.get('kind', '?')}: {c.get('detail', '')}"
        + ("  (nothing submitted, nothing kept by the portal)"
           if not c.get("submitted_to_portal") else "")
        for c in result.external_changes
    ], "none -- read-only throughout; nothing was submitted, saved or sent"))

    lines.append("")
    lines.append(f"safe resume command     {result.resume_command}")
    if result.status == COMPLETED:
        lines.append(
            "                        (not needed -- resuming a finished run "
            "re-reads nothing)"
        )
    lines.append(f"evidence                {result.evidence_dir}")
    return "\n".join(lines)


def _record_line(record: dict[str, Any]) -> str:
    parts = [str(record.get("identifier", "?"))]
    for key in ("customer", "site"):
        value = str(record.get(key) or "").strip()
        if value and value not in parts:
            parts.append(value)
    date = str(record.get("end_date") or record.get("date") or "").strip()
    if date:
        parts.append(date)
    status = str(record.get("status") or "").strip()
    if status:
        parts.append(f"[{status}]")
    return "  ".join(parts)


def render_json(result: OperationResult) -> str:
    return json.dumps(result.to_dict(), indent=2, sort_keys=True)


def render_visit(result: OperationResult) -> str:
    """The ``visit-findings`` block.

    Different shape from ``render`` on purpose: this operation's answer is one
    visit and one reviewable file, not a list of 121 rows, and burying the path
    to that file under a table of contents would be the wrong emphasis.
    """
    from .visit_operation import STEPS as VISIT_STEPS

    lines: list[str] = []
    lines.append(f"run id                  {result.run_id}")
    lines.append(
        f"status                  {result.status}"
        f"  ({STATUS_MEANING.get(result.status, '')})"
    )

    done = result.steps_completed
    lines.append(f"steps completed         {len(done)}/{len(VISIT_STEPS)}")
    for step in VISIT_STEPS:
        lines.append(f"    {'done' if step in done else '  --'}  {step}")

    lines.append("")
    lines.append("site visit read")
    lines.extend(_bullets([_record_line(r) for r in result.records],
                          "none -- no visit was chosen"))

    lines.append("")
    lines.append("knowledge used")
    lines.extend(_bullets([
        f"{k.get('record_id', '?')}  v{k.get('version', '?')}  ({k.get('trust', '?')})"
        for k in result.knowledge_used
    ], "none -- this run worked everything out from scratch"))

    lines.append("")
    lines.append("stale knowledge detected")
    lines.extend(_bullets([
        f"{s.get('record_id', '?')}  v{s.get('version', '?')}  "
        f"{s.get('trust_before', '?')} -> {s.get('trust_after', '?')}"
        for s in result.stale_knowledge
    ], "none -- everything the run believed still held"))

    lines.append("")
    lines.append("corrected knowledge created")
    lines.extend(_bullets([
        f"{c.get('record_id', '?')}  v{c.get('version', '?')}  ({c.get('trust', '?')})"
        for c in result.corrected_knowledge
    ], "none -- nothing needed correcting"))

    lines.append("")
    lines.append("human action required")
    lines.extend(_bullets(result.human_action_required, "none"))

    lines.append("")
    lines.append("external changes performed")
    lines.extend(_bullets([
        f"{c.get('kind', '?')}: {c.get('detail', '')}"
        for c in result.external_changes
    ], "none -- read-only throughout; nothing was submitted, approved or sent"))

    lines.append("")
    lines.append("notes")
    lines.extend(_bullets(result.notes, "none"))

    lines.append("")
    lines.append(f"safe resume command     {result.resume_command}")
    lines.append(f"run folder              {result.evidence_dir}")
    if result.status == COMPLETED:
        lines.append("")
        lines.append("The result is a DRAFT for a person to check. It is not a")
        lines.append("quotation and nothing was sent to TEGG or to a customer.")
    return "\n".join(lines)
