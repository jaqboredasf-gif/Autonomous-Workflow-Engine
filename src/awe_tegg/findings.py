"""What the inspection reports actually say, in a shape that survives.

Two TEGG reports carry the inspection result, and they are read here into one
durable, versioned record set:

  * **Equipment Item Problems Report** -- one page per problem. It carries the
    tag, the equipment, the technician's own problem description, the severity,
    which repairs they recommended, what happens if nobody does them, and --
    the field a coworker actually acts on -- whether an **estimate is
    required**. This is the primary source.
  * **Standard IR Report** -- the infrared sheets. Two pages per problem,
    carrying the thermal measurement (problem temperature, difference
    temperature) and the severity bands those are judged against. Read as
    *corroboration*, matched to a problem by tag.

## Why this reads coordinates rather than lines of text

Both reports are SSRS output. Their checkboxes are not characters in a
sentence: an ``X`` is a separate text run positioned to the left of the label
it ticks. Reading the page as a stream of lines puts that ``X`` next to
whichever label happens to follow it, and the order is not stable between
pages -- on one page ``Problem Corrected`` precedes its mark and on another it
follows it. Getting that wrong does not produce a parse error, it produces a
*confident wrong answer* about whether a fire hazard was recorded.

So the rule is geometric and checkable: an ``X`` at (x, y) ticks the label
whose text begins within a few points to its right on the same line.

    X at (192.5, 527.2)  ->  "Fire Hazard" at (212.5, 529.7)

Measured on live output: the offset is 15-20 points right and within 3 points
vertically, every time.

## Why an unclaimed X is an error

If an ``X`` on the page is not claimed by any label, this parser does not know
what was ticked, and neither does anybody reading its output. That page is
flagged rather than reported. The same goes for a label claimed by two marks.
An inspection finding that is quietly half-read is worse than one that is
loudly not read, because only the loud one gets looked at.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

#: Bump when the meaning of a stored field changes. Consumers check it.
FINDINGS_SCHEMA_VERSION = 1

#: How far right of an ``X`` its label starts, and how far off the same line it
#: may sit. Both measured from live SSRS output, then widened by roughly half
#: again so a font-metric change does not silently drop a tick.
MARK_DX = (3.0, 30.0)
MARK_DY = 5.0

EIP_TITLE = "Equipment Item Problems Report"
IR_TITLE = "Infrared Inspection Report Sheet"

#: The problem's own severity word, worst first. The report prints exactly one.
SEVERITIES = ("Critical", "Severe", "Alert", "Normal")

#: Checkbox labels, by the group they belong to. Nothing outside this map is
#: treated as a checkbox, so a stray "X" beside a data value cannot invent one.
CHECKBOX_GROUPS: dict[str, tuple[str, ...]] = {
    "recommendation": ("Repair Equipment", "Replace Equipment"),
    "consequence": (
        "Equipment Failure",
        "Fire Hazard",
        "Safety Hazard",
        "Power/Business Interruption",
    ),
    "corrective_action": (
        "Fixed During Visit",
        "Contractor Will Correct",
        "Customer Will Correct",
        "Estimate Required",
    ),
    "status": ("Problem Corrected",),
    "urgency": ("Immediate Hazard", "Customer Notified Immediately"),
}
ALL_CHECKBOXES = tuple(
    label for labels in CHECKBOX_GROUPS.values() for label in labels
)


class FindingsError(Exception):
    """A document could not be read as the report it claims to be."""


class EmptyReport(FindingsError):
    """The report rendered, and there was nothing in it to render.

    A distinct case from "this is the wrong document", and the difference
    matters to the person reading the result. A site visit where the technician
    recorded no equipment problems produces a blank Equipment Item Problems
    Report -- that is a real, useful answer ("nothing to quote") and reporting
    it as a parse failure would send somebody looking for a bug that is not
    there. It is only trusted when the other report agrees.
    """


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------


@dataclass
class SourceRef:
    """Exactly where a fact came from, in a form somebody can go and check."""

    document: str = ""          # canonical report name
    filename: str = ""          # what it is called on this machine
    sha256: str = ""            # of the whole PDF, so a swap is detectable
    page: int = 0               # 1-based, as printed
    page_label: str = ""        # SSRS's own label, e.g. "2A"
    quote: str = ""             # the words this fact was read from

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def cite(self) -> str:
        label = self.page_label or str(self.page)
        return f"{self.document}, page {label}"


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------


@dataclass
class Thermal:
    """The infrared measurement for one problem, and the bands judging it."""

    problem_temperature_c: float | None = None
    difference_temperature_c: float | None = None
    reference_temperature_c: float | None = None
    bands: dict[str, str] = field(default_factory=dict)
    derived_severity: str = ""
    source: SourceRef | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source"] = self.source.to_dict() if self.source else None
        return data


@dataclass
class Finding:
    """One equipment problem, as the inspection recorded it.

    Every field here was read off a page. Nothing is inferred except
    ``derived_severity`` on the thermal block, which is arithmetic against the
    report's own printed bands and is labelled as derived.
    """

    finding_id: str = ""
    tag_id: str = ""
    customer_id: str = ""
    equipment_type: str = ""
    location: str = ""
    technician: str = ""
    observed_on: str = ""
    severity: str = ""
    problem_description: str = ""
    #: What the technician wrote under "Recommendations For Repair" and
    #: "Corrective Actions". This is the repair advice, in their words.
    narrative: list[str] = field(default_factory=list)
    #: What they wrote under "Consequences if Not Corrected".
    consequence_narrative: str = ""
    recommendation: dict[str, bool] = field(default_factory=dict)
    consequence: dict[str, bool] = field(default_factory=dict)
    corrective_action: dict[str, bool] = field(default_factory=dict)
    status: dict[str, bool] = field(default_factory=dict)
    urgency: dict[str, bool] = field(default_factory=dict)
    thermal: Thermal | None = None
    source: SourceRef | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def estimate_required(self) -> bool:
        return bool(self.corrective_action.get("Estimate Required"))

    @property
    def problem_corrected(self) -> bool:
        return bool(self.status.get("Problem Corrected"))

    @property
    def ticked_consequences(self) -> list[str]:
        return [k for k, v in self.consequence.items() if v]

    @property
    def trustworthy(self) -> bool:
        """False when this page's marks could not be read unambiguously."""
        return not self.warnings

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["source"] = self.source.to_dict() if self.source else None
        data["thermal"] = self.thermal.to_dict() if self.thermal else None
        data["estimate_required"] = self.estimate_required
        data["problem_corrected"] = self.problem_corrected
        return data


@dataclass
class FindingSet:
    """Every finding read for one site visit, with what produced it."""

    schema_version: int = FINDINGS_SCHEMA_VERSION
    site_visit: str = ""
    customer: str = ""
    site: str = ""
    agreement: str = ""
    contractor: str = ""
    documents: list[dict[str, Any]] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: Set when the visit legitimately recorded no problems. Empty otherwise,
    #: so "no findings" and "no findings, and here is why that is correct" are
    #: never the same state.
    empty_reason: str = ""

    @property
    def needing_estimate(self) -> list[Finding]:
        return [f for f in self.findings if f.estimate_required]

    @property
    def open_findings(self) -> list[Finding]:
        return [f for f in self.findings if not f.problem_corrected]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "site_visit": self.site_visit,
            "customer": self.customer,
            "site": self.site,
            "agreement": self.agreement,
            "contractor": self.contractor,
            "documents": list(self.documents),
            "findings": [f.to_dict() for f in self.findings],
            "warnings": list(self.warnings),
            "empty_reason": self.empty_reason,
            "counts": {
                "findings": len(self.findings),
                "estimate_required": len(self.needing_estimate),
                "not_corrected": len(self.open_findings),
                "with_warnings": len([f for f in self.findings if f.warnings]),
            },
        }


# ---------------------------------------------------------------------------
# Reading a page
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Run:
    """One positioned run of text, as the PDF lays it out."""

    x: float
    y: float
    size: float
    text: str

    @property
    def placed(self) -> bool:
        """Whether the PDF actually positioned this run.

        SSRS emits some hidden runs at the origin. A label there was not drawn,
        so it cannot have been ticked, and a mark there cannot tick anything.
        """
        return not (self.x == 0.0 and self.y == 0.0)


def read_runs(page: Any) -> list[Run]:
    runs: list[Run] = []

    def visit(text: str, cm, tm, font_dict, font_size) -> None:  # noqa: ANN001
        stripped = (text or "").strip()
        if stripped:
            runs.append(
                Run(round(tm[4], 2), round(tm[5], 2), float(font_size or 0), stripped)
            )

    page.extract_text(visitor_text=visit)
    return runs


def read_checkboxes(runs: Iterable[Run]) -> tuple[dict[str, bool], list[str]]:
    """Which labels are ticked, and every reason not to believe the answer.

    An ``X`` claims the nearest label to its right on its own line. Then two
    things are checked, and both are failures rather than tie-breaks:

      * a mark no label claimed -- something was ticked and we cannot say what;
      * a label two marks claimed -- ambiguous geometry.
    """
    runs = list(runs)
    marks = [r for r in runs if r.text in ("X", "x") and r.placed]
    labels = [r for r in runs if r.text in ALL_CHECKBOXES]

    ticked: dict[str, bool] = {label: False for label in ALL_CHECKBOXES}
    claimed_by: dict[str, list[Run]] = {}
    unclaimed: list[Run] = []

    for mark in marks:
        candidates = [
            label for label in labels
            if label.placed
            and abs(label.y - mark.y) <= MARK_DY
            and MARK_DX[0] <= (label.x - mark.x) <= MARK_DX[1]
        ]
        if not candidates:
            unclaimed.append(mark)
            continue
        # If two labels are in range, the nearer one wins -- but the ambiguity
        # is still reported below, because "nearer" is not evidence.
        winner = min(candidates, key=lambda label: label.x - mark.x)
        ticked[winner.text] = True
        claimed_by.setdefault(winner.text, []).append(mark)

    problems: list[str] = []
    for mark in unclaimed:
        problems.append(
            f"a tick at ({mark.x}, {mark.y}) matched no checkbox label; "
            "this page's boxes were not read"
        )
    for label, claims in claimed_by.items():
        if len(claims) > 1:
            problems.append(f"{label!r} was claimed by {len(claims)} ticks")
    return ticked, problems


def group_checkboxes(ticked: dict[str, bool]) -> dict[str, dict[str, bool]]:
    return {
        group: {label: ticked.get(label, False) for label in labels}
        for group, labels in CHECKBOX_GROUPS.items()
    }


# ---------------------------------------------------------------------------
# The Equipment Item Problems Report
# ---------------------------------------------------------------------------

_TAG_LINE = re.compile(r"^(?P<tag>\d{3,})\s*(?P<rest>.*)$")


def _nearest_right(runs: list[Run], anchor: str, *, dy: float = 14.0) -> str:
    """The value printed under a caption like ``Tag ID:``."""
    captions = [r for r in runs if r.text.rstrip(":") == anchor.rstrip(":")]
    for caption in captions:
        if not caption.placed:
            continue
        below = [
            r for r in runs
            if r.placed and r is not caption
            and 0 < (caption.y - r.y) <= dy
            and abs(r.x - caption.x) <= 30.0
            and r.text.rstrip(":") != anchor.rstrip(":")
        ]
        if below:
            return min(below, key=lambda r: caption.y - r.y).text
    return ""


#: The page's own section headings, in the order SSRS lays them down. Free text
#: belongs to the heading directly above it, which is the only thing on the page
#: that says what a paragraph *is*. Reading paragraphs by position alone puts
#: the contractor's letterhead where the technician's problem description
#: should be, and that is a wrong answer rather than a missing one.
SECTION_HEADINGS = (
    ("problem", "Problem Description -"),
    ("consequence", "Consequences if Not Corrected"),
    ("recommendation", "Recommendations For Repair"),
    ("corrective", "Corrective Actions"),
)


#: Captions that name a field rather than being one.
CAPTIONS = frozenset({
    "Tag ID:", "Equipment Type:", "Location:", "Technician:", "Page",
    "Reference Temperature", "Problem Temperature", "Difference Temperature",
    "Variables", "Parameters", "Problem Location",
})

_NUMERIC = re.compile(r"^[\d.,/:%°ChHmMvVaA\s-]+$")


def _is_body(run: Run) -> bool:
    """Whether a run is something a technician typed, rather than furniture."""
    text = run.text.strip()
    if not run.placed or not text:
        return False
    if text in ALL_CHECKBOXES or text in CAPTIONS or text in SEVERITIES:
        return False
    if text in ("X", "x") or _NUMERIC.match(text):
        return False
    if any(text.startswith(heading) for _, heading in SECTION_HEADINGS):
        return False
    return True


def _sections(runs: list[Run], *, min_words: int = 4) -> dict[str, list[str]]:
    """The free text on the page, filed under the heading it sits beneath.

    Two passes, because a wrapped paragraph does not arrive as one run. SSRS
    bottom-aligns each text box, so the second line of a two-line entry lands
    several points below the first and its fragment can be two words long --
    "cover removal", "installation.". A word-count filter alone silently
    truncates the technician's repair instruction at the line break, which is
    the one kind of error this whole module exists to avoid. So a short run in
    the same left-hand column as a full line, under the same heading, is kept
    as its continuation.
    """
    headings: list[tuple[str, float]] = []
    for key, text in SECTION_HEADINGS:
        found = [r for r in runs if r.text == text and r.placed]
        if found:
            headings.append((key, max(r.y for r in found)))
    headings.sort(key=lambda h: -h[1])

    def band_of(run: Run) -> str:
        above = [key for key, y in headings if y > run.y]
        return above[-1] if above else ""

    body = [r for r in runs if _is_body(r)]
    # The columns free text is set in, taken across the whole page rather than
    # per section. SSRS bottom-aligns each text box, so a wrapped paragraph's
    # second line can be pushed past the *next* heading -- "cover removal" on a
    # page whose recommendation heading is 100 points above it. Filing that
    # fragment under the wrong heading loses a few words of context; dropping
    # it loses part of a repair instruction.
    columns = {
        round(r.x, 0) for r in body if len(r.text.split()) >= min_words
    }
    kept = [
        r for r in body
        if len(r.text.split()) >= min_words or round(r.x, 0) in columns
    ]
    kept.sort(key=lambda r: (-r.y, r.x))

    out: dict[str, list[str]] = {key: [] for key, _ in SECTION_HEADINGS}
    for run in kept:
        band = band_of(run)
        if band:            # above every heading is letterhead, not content
            out[band].append(run.text)
    return out


def parse_equipment_item_problems(path: Path) -> list[Finding]:
    """One finding per page of the Equipment Item Problems Report."""
    reader = _open_pdf(path)
    digest = checksum(path)
    findings: list[Finding] = []

    for index, page in enumerate(reader.pages, start=1):
        runs = read_runs(page)
        text = " ".join(r.text for r in runs)
        if EIP_TITLE not in text:
            continue

        ticked, problems = read_checkboxes(runs)
        groups = group_checkboxes(ticked)

        tag_run = _nearest_right(runs, "Tag ID:")
        equipment = _nearest_right(runs, "Equipment Type:")
        location = _nearest_right(runs, "Location:")
        technician = _nearest_right(runs, "Technician:")

        tag_id, customer_id = _split_tag(tag_run)
        severity = _severity_on(runs)
        sections = _sections(runs)
        described = sections["problem"]
        recommended = sections["recommendation"] + sections["corrective"]

        source = SourceRef(
            document=EIP_TITLE, filename=path.name, sha256=digest,
            page=index, page_label=str(index),
            quote=described[0] if described else "",
        )
        finding = Finding(
            finding_id=f"{tag_id or 'page'}-{index}",
            tag_id=tag_id,
            customer_id=customer_id,
            equipment_type=equipment,
            location=location,
            technician=technician,
            observed_on=_date_on(runs),
            severity=severity,
            problem_description=" ".join(described),
            narrative=recommended,
            consequence_narrative=" ".join(sections["consequence"]),
            recommendation=groups["recommendation"],
            consequence=groups["consequence"],
            corrective_action=groups["corrective_action"],
            status=groups["status"],
            urgency=groups["urgency"],
            source=source,
            warnings=problems,
        )
        if not tag_id:
            finding.warnings.append("no tag id could be read from this page")
        if not described:
            finding.warnings.append("no problem description could be read")
        if not recommended:
            finding.warnings.append(
                "no repair text was recorded under 'Recommendations For Repair'"
            )
        findings.append(finding)

    if not findings:
        blank = all(
            not " ".join(r.text for r in read_runs(page)).strip()
            for page in reader.pages
        )
        if blank:
            raise EmptyReport(
                f"{path.name} is a blank {EIP_TITLE}: the report rendered and "
                "carried no problems at all"
            )
        raise FindingsError(
            f"{path.name} carries no page headed {EIP_TITLE!r}. It is not the "
            "Equipment Item Problems Report, or the export produced an empty "
            "one -- check the Agreement was set before Print Report."
        )
    return findings


def ir_records_problems(path: Path) -> bool:
    """Whether the IR report contains any problem sheet at all.

    Used to corroborate a blank problems report. Two documents saying "no
    problems" is a clean visit; one saying it while the other lists thermal
    faults is a retrieval that went wrong, and the two must not be confused.
    """
    try:
        reader = _open_pdf(path)
    except FindingsError:
        return False
    for page in reader.pages:
        text = " ".join(r.text for r in read_runs(page))
        if IR_TITLE in text and "Severity Criteria" in text:
            return True
    return False


def _split_tag(value: str) -> tuple[str, str]:
    """``"03303 SW #2-6"`` -> tag ``03303``, customer id ``SW #2-6``."""
    match = _TAG_LINE.match(value.strip())
    if not match:
        return "", value.strip()
    return match.group("tag"), match.group("rest").strip()


def _severity_on(runs: list[Run]) -> str:
    placed = {r.text for r in runs if r.placed}
    for word in SEVERITIES:
        if word in placed:
            return word
    return ""


_DATE = re.compile(r"^\d{1,2}/\d{1,2}/\d{4}$")


def _date_on(runs: list[Run]) -> str:
    for run in runs:
        if _DATE.match(run.text):
            return run.text
    return ""


# ---------------------------------------------------------------------------
# The Standard IR Report
# ---------------------------------------------------------------------------

_TEMP = re.compile(r"^(-?\d+(?:\.\d+)?)\s*C$", re.IGNORECASE)
_BAND = re.compile(r"^(Less Than|Greater Than)?\s*(-?\d+(?:\.\d+)?)C"
                   r"(?:\s*-\s*(-?\d+(?:\.\d+)?)C)?$", re.IGNORECASE)


def parse_standard_ir(path: Path) -> dict[str, Thermal]:
    """The thermal measurement for each tag, keyed by tag id.

    The IR sheets run two pages per problem: the measurement and its bands are
    on the ``A`` page, the corrective detail on the ``B`` page. Only the
    measurement is taken here -- the Equipment Item Problems Report is the
    authority on what was recommended, and two sources disagreeing about that
    is a thing to notice rather than to average.
    """
    reader = _open_pdf(path)
    digest = checksum(path)
    out: dict[str, Thermal] = {}

    for index, page in enumerate(reader.pages, start=1):
        runs = read_runs(page)
        text = " ".join(r.text for r in runs)
        if IR_TITLE not in text or "Severity Criteria" not in text:
            continue

        bands = _bands(runs)
        problem_c = _labelled_temperature(runs, "Problem Temperature")
        difference_c = _labelled_temperature(runs, "Difference Temperature")
        reference_c = _labelled_temperature(runs, "Reference Temperature")
        tag_id, _ = _split_tag(_tagish(runs))
        if not tag_id:
            continue

        out[tag_id] = Thermal(
            problem_temperature_c=problem_c,
            difference_temperature_c=difference_c,
            reference_temperature_c=reference_c,
            bands=bands,
            derived_severity=severity_for(difference_c, bands),
            source=SourceRef(
                document=IR_TITLE, filename=path.name, sha256=digest,
                page=index, page_label=_page_label(runs) or str(index),
                quote=f"difference temperature {difference_c}C" if difference_c
                      is not None else "",
            ),
        )
    return out


def severity_for(difference_c: float | None, bands: dict[str, str]) -> str:
    """Which printed band a difference temperature falls in. Arithmetic only.

    Returns "" when the report did not print enough to decide, which is a real
    answer and better than guessing at a boundary.
    """
    if difference_c is None or not bands:
        return ""
    for name in ("Critical", "Severe", "Alert", "Normal"):
        text = bands.get(name, "")
        match = _BAND.match(text.strip())
        if not match:
            continue
        qualifier, low, high = match.group(1), match.group(2), match.group(3)
        low_value = float(low)
        if qualifier and qualifier.lower() == "greater than":
            if difference_c > low_value:
                return name
        elif qualifier and qualifier.lower() == "less than":
            if difference_c < low_value:
                return name
        elif high is not None and low_value <= difference_c <= float(high):
            return name
    return ""


def _bands(runs: list[Run]) -> dict[str, str]:
    """Pair each severity word with the range printed directly beneath it."""
    words = [r for r in runs if r.text in SEVERITIES and r.placed]
    ranges = [r for r in runs if _BAND.match(r.text) and r.placed]
    bands: dict[str, str] = {}
    for word in words:
        below = [
            r for r in ranges
            if abs(r.x - word.x) <= 6.0 and 0 < (word.y - r.y) <= 30.0
        ]
        if below:
            bands[word.text] = min(below, key=lambda r: word.y - r.y).text
    return bands


def _labelled_temperature(runs: list[Run], caption: str) -> float | None:
    captions = [r for r in runs if r.text == caption and r.placed]
    values = [r for r in runs if _TEMP.match(r.text) and r.placed]
    for anchor in captions:
        below = [
            r for r in values
            if abs(r.x - anchor.x) <= 6.0 and 0 < (anchor.y - r.y) <= 30.0
        ]
        if below:
            nearest = min(below, key=lambda r: anchor.y - r.y)
            return float(_TEMP.match(nearest.text).group(1))
    return None


def _page_label(runs: list[Run]) -> str:
    anchors = [r for r in runs if r.text == "Page" and r.placed]
    for anchor in anchors:
        right = [
            r for r in runs
            if r.placed and abs(r.y - anchor.y) <= 4.0 and 0 < (r.x - anchor.x) <= 120
        ]
        if right:
            return min(right, key=lambda r: r.x - anchor.x).text
    return ""


def _tagish(runs: list[Run]) -> str:
    """The tag line on an IR sheet, which SSRS sometimes leaves unpositioned."""
    for run in runs:
        if _TAG_LINE.match(run.text) and len(run.text.split()) >= 2:
            return run.text
    return ""


# ---------------------------------------------------------------------------
# Putting the two together
# ---------------------------------------------------------------------------


def build(
    *,
    equipment_item_problems: Path,
    standard_ir: Path | None = None,
    site_visit: str = "",
    customer: str = "",
    site: str = "",
    agreement: str = "",
    contractor: str = "",
) -> FindingSet:
    """Read both reports into one finding set, corroborating by tag."""
    documents = [_document_ref(equipment_item_problems, EIP_TITLE)]
    warnings: list[str] = []
    empty_reason = ""

    try:
        findings = parse_equipment_item_problems(equipment_item_problems)
    except EmptyReport as blank:
        # A blank problems report is only believed when the infrared report
        # agrees. If the IR sheets do list faults, the two documents disagree
        # and that is a retrieval problem, not a clean visit.
        if standard_ir is not None and ir_records_problems(standard_ir):
            raise FindingsError(
                f"{Path(equipment_item_problems).name} came back blank, but the "
                "Standard IR Report does contain problem sheets. The two "
                "disagree, so neither is trusted -- retry the retrieval."
            ) from blank
        findings = []
        empty_reason = str(blank) + (
            "; the Standard IR Report lists no problem sheets either"
            if standard_ir is not None else ""
        )
        if standard_ir is not None:
            documents.append(_document_ref(standard_ir, IR_TITLE))
        return FindingSet(
            site_visit=site_visit, customer=customer, site=site,
            agreement=agreement, contractor=contractor,
            documents=documents, findings=[], warnings=warnings,
            empty_reason=empty_reason,
        )

    thermal: dict[str, Thermal] = {}
    if standard_ir is not None:
        documents.append(_document_ref(standard_ir, IR_TITLE))
        try:
            thermal = parse_standard_ir(standard_ir)
        except FindingsError as error:                      # pragma: no cover
            warnings.append(f"the IR report could not be read: {error}")

    matched = 0
    for finding in findings:
        measurement = thermal.get(finding.tag_id)
        if measurement is not None:
            finding.thermal = measurement
            matched += 1
    if thermal and not matched:
        warnings.append(
            f"the IR report described {len(thermal)} tag(s) and none of them "
            "matched a problem in the Equipment Item Problems Report; the "
            "thermal figures are not attached to anything"
        )

    unreadable = [f for f in findings if f.warnings]
    if unreadable:
        warnings.append(
            f"{len(unreadable)} of {len(findings)} page(s) had checkboxes that "
            "could not be read unambiguously and are marked for a person"
        )

    return FindingSet(
        site_visit=site_visit, customer=customer, site=site,
        agreement=agreement, contractor=contractor,
        documents=documents, findings=findings, warnings=warnings,
    )


def _document_ref(path: Path, title: str) -> dict[str, Any]:
    return {
        "document": title,
        "filename": path.name,
        "sha256": checksum(path),
        "bytes": path.stat().st_size,
    }


def _open_pdf(path: Path) -> Any:
    path = Path(path)
    if not path.exists():
        raise FindingsError(f"{path} does not exist")
    try:
        import pypdf
    except ImportError as error:                            # pragma: no cover
        raise FindingsError("pypdf is not installed") from error

    # SSRS emits duplicate image keys; pypdf is right to mention it once and
    # wrong to mention it eighty times per document.
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    try:
        return pypdf.PdfReader(str(path))
    except Exception as error:
        raise FindingsError(f"{path.name} could not be opened as a PDF: {error}") from error
