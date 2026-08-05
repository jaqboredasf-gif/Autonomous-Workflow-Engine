"""The documents a completed TEGG package owes, and the proof it produced them.

The Windows mock run reported success having produced two documents. It was
not lying: two was all the operation had ever promised, because
``documents.py`` named exactly two report routes and nothing anywhere stated
what a *finished package* consists of. A run cannot fall short of a contract
that was never written down.

So this module is that contract, in one place.

## The contract

Eight documents, in the order the package lists them. They come from **three
different places**, which is the thing most likely to be got wrong:

  * the **Table of Contents** is a static file that ships with the tool. It is
    copied into every package; it is not fetched from TEGG at all.
  * the **Certificate** comes from the Document Library tab, selected by
    *Solution* (the agreement) and produced with *Print/Generate Document*. It
    is a different route, with different parameters, and it arrives as a legacy
    ``.doc`` that has to be converted.
  * the **six reports** come from Reports -> Standard ESA Reports, each
    rendered by SSRS and exported as PDF.

Every route below is a label observed on the live portal on 2026-07-29 and
recorded in ``config/workflow.yaml``. None is guessed, and none is assumed to
be shared: the live Reports list offers *four* different reports whose name
ends in "Summary" (Problem Count, EDS Component Problem, Inventory, Visual
Inspection, Tasking Completion), so a route is never inferred from a name.

## What enforcement means

:meth:`Manifest.enforce` refuses to call a run successful unless every one of
the eight is present, valid, distinct, and of the type its slot expects. That
refusal is the whole point of the module: a short package is worse than no
package, because a short one gets sent.

The review page and its JSON are recorded here too, but they are
**additional** -- they do not gate success.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

MANIFEST_NAME = "deliverables.json"

#: Where a document comes from. These are genuinely different mechanisms, not
#: labels: each needs different code, different parameters and different
#: failure handling.
FROM_STATIC = "static asset shipped with the tool"
FROM_DOCUMENT_LIBRARY = "TEGG Document Library (Print/Generate Document)"
FROM_ESA_REPORT = "TEGG Reports > Standard ESA Reports (SSRS render)"

#: Generation status.
PENDING = "pending"
GENERATED = "generated"
COPIED = "copied"          # a static asset placed into the package
CONVERTED = "converted"    # arrived in another format and was converted
REUSED = "reused"          # already on disk, checksum matched
FAILED = "failed"

#: Statuses that count as "this document was produced".
PRODUCED_STATUSES = frozenset({GENERATED, COPIED, CONVERTED, REUSED})

#: Validation status.
UNCHECKED = "unchecked"
VALID = "valid"
NOT_PDF = "not-a-pdf"
EMPTY = "empty"
MISSING = "missing"
DUPLICATE = "duplicate-of-another-document"

#: There is deliberately no "looks big enough" threshold here.
#:
#: An earlier version failed anything under 8 kB as an empty render. That is
#: the wrong test twice over: a site with two problems has a legitimately short
#: Problem Count Summary, which it would fail, and a large error page would
#: pass. What is checked instead is that the file re-opens as a PDF with pages
#: in it, which no truncated transfer or error body does.
#:
#: The real defence against a *contentless* render is upstream, in
#: ``documents.set_parameters``: it refuses a form whose agreement list says
#: "there are currently no agreements", which is the condition that actually
#: produces an empty report, and it is caught before Export is ever clicked.


@dataclass(frozen=True)
class Expected:
    """One document, described before anything tries to produce it."""

    key: str
    #: What this document is called in the package, the manifest and the email.
    canonical_name: str
    #: The filename it lands under. ``{visit}`` becomes the visit identifier.
    filename_template: str
    #: Which mechanism produces it.
    source: str
    #: For an ESA report or a Document Library item: the path through the UI.
    #: A step that is not the last only expands a parent.
    route: tuple[str, ...] = ()
    #: The parameters the route's form needs, for the manifest and for anyone
    #: debugging a failure. Recorded, not executed.
    parameters: tuple[str, ...] = ()
    #: For a static asset: the filename to copy out of ``assets/static``.
    static_source: str = ""
    #: Whether the produced file needs converting before it is a PDF.
    needs_conversion: bool = False

    def filename(self, visit: str) -> str:
        stem = (visit or "visit").replace("/", "-").replace(" ", "-")
        return self.filename_template.format(visit=stem)

    @property
    def from_portal(self) -> bool:
        return self.source in (FROM_DOCUMENT_LIBRARY, FROM_ESA_REPORT)


#: The eight, in package order.
#:
#: NOTE ON COUNT: the correction that produced this list named seven documents
#: but described document 2 as "Certificate - Standard IR". Those are two
#: separate items on the live portal, on two different routes with different
#: parameters, and the decision taken was to require both. That makes eight.
#: See docs/MOCK_RUN_READINESS.md.
REQUIRED: tuple[Expected, ...] = (
    Expected(
        key="table_of_contents",
        canonical_name="TEGG Table of Contents",
        filename_template="ESA Table of Contents.pdf",
        source=FROM_STATIC,
        static_source="ESA Table of Contents.pdf",
    ),
    Expected(
        key="certificate",
        canonical_name="Certificate",
        filename_template="{visit}-Certificate.pdf",
        source=FROM_DOCUMENT_LIBRARY,
        route=("Document Library", "Certificates"),
        parameters=("Solution = <agreement>",),
        needs_conversion=True,
    ),
    Expected(
        key="standard_ir",
        canonical_name="Standard IR Report",
        filename_template="{visit}-StandardIRReport.pdf",
        source=FROM_ESA_REPORT,
        route=("Standard IR Report",),
        parameters=("Agreement = <agreement>",),
    ),
    Expected(
        key="equipment_inventory_long",
        canonical_name="Inventory Equipment - Long Form",
        filename_template="{visit}-EquipmentInventoryLongForm.pdf",
        source=FROM_ESA_REPORT,
        route=("Equipment Inventory", "Long Form"),
        parameters=("Agreement = <agreement>",),
    ),
    Expected(
        key="equipment_inventory_short",
        canonical_name="Inventory Equipment - Short Form",
        filename_template="{visit}-EquipmentInventoryShortForm.pdf",
        source=FROM_ESA_REPORT,
        route=("Equipment Inventory", "Short Form"),
        parameters=("Agreement = <agreement>", "Order By = Locations"),
    ),
    Expected(
        key="problem_count_summary",
        canonical_name="Problem Counts",
        filename_template="{visit}-ProblemCountSummary.pdf",
        source=FROM_ESA_REPORT,
        route=("Problem Count Summary",),
        parameters=("Agreement = <agreement>",),
    ),
    Expected(
        key="eds_all_problems",
        canonical_name="Summary (EDS Component Problem Summary)",
        filename_template="{visit}-EDSComponentProblemSummary.pdf",
        source=FROM_ESA_REPORT,
        route=("EDS Component Problem Summary", "All Problems"),
        parameters=("Agreement = <agreement>",),
    ),
    Expected(
        key="equipment_problems",
        canonical_name="Equipment Problems",
        filename_template="{visit}-EquipmentItemProblems.pdf",
        source=FROM_ESA_REPORT,
        route=("Equipment Item Problems", "Exclude All Images"),
        parameters=("Agreement = <agreement>",),
    ),
)

REQUIRED_COUNT = len(REQUIRED)
BY_KEY = {item.key: item for item in REQUIRED}

#: The documents that come from the portal, in retrieval order.
PORTAL_REQUIRED = tuple(item for item in REQUIRED if item.from_portal)

#: The one document the findings parser reads. Its absence is fatal earlier and
#: for a different reason than the package being short, so it is named.
FINDINGS_SOURCE = "equipment_problems"

#: The Standard IR Report corroborates the findings. Named for the same reason.
FINDINGS_CORROBORATION = "standard_ir"

#: Long and Short Form are separate deliverables, not alternatives. The
#: 2026-07-29 dry run downloaded the Short Form and failed the Long Form
#: independently, on the same site, in the same run -- which is the evidence
#: that they are two documents rather than two names for one.
INVENTORY_PAIR = ("equipment_inventory_long", "equipment_inventory_short")


class DeliverableError(Exception):
    """The package is not publishable, and the run must not be called done."""


@dataclass
class Entry:
    """One row of the manifest: what was owed, and what actually happened."""

    key: str
    canonical_name: str
    expected_filename: str
    source: str
    route: str = ""
    parameters: str = ""
    generated_filename: str = ""
    status: str = PENDING
    validation: str = UNCHECKED
    page_count: int | None = None
    location: str = ""
    bytes: int = 0
    sha256: str = ""
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status in PRODUCED_STATUSES and self.validation == VALID

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def validate_pdf(path: Path) -> tuple[str, str, int | None]:
    """Judge one produced file. Returns (validation, detail, page count).

    A file that exists is not a document. Three things are checked, in
    increasing order of cost: it is there, it carries a PDF header, and it
    actually re-opens with at least one page. The last is the one that matters
    -- an error page saved with a ``.pdf`` name, or a transfer that stopped
    halfway, passes the first two and fails the third.
    """
    path = Path(path)
    if not path.exists():
        return MISSING, f"nothing at {path}", None
    size = path.stat().st_size
    if size == 0:
        return EMPTY, "the file is zero bytes", None
    try:
        head = path.open("rb").read(5)
    except OSError as error:
        return MISSING, f"could not be read: {error}", None
    if head != b"%PDF-":
        return NOT_PDF, f"starts {head!r}, which is not a PDF header", None

    try:
        from pypdf import PdfReader

        pages = len(PdfReader(str(path)).pages)
    except Exception as error:                              # noqa: BLE001
        return NOT_PDF, f"has a PDF header but will not open: {error}", None
    if pages < 1:
        return EMPTY, "opens, but contains no pages", 0
    return VALID, f"{pages} page(s), {size:,} bytes", pages


@dataclass
class Manifest:
    """Every expected document, and what became of it."""

    site_visit: str = ""
    entries: list[Entry] = field(default_factory=list)
    #: Produced by the same run, recorded, but not gating success.
    additional: list[Entry] = field(default_factory=list)

    @classmethod
    def create(cls, site_visit: str) -> "Manifest":
        return cls(
            site_visit=site_visit,
            entries=[
                Entry(
                    key=item.key,
                    canonical_name=item.canonical_name,
                    expected_filename=item.filename(site_visit),
                    source=item.source,
                    route=" > ".join(item.route),
                    parameters="; ".join(item.parameters),
                )
                for item in REQUIRED
            ],
        )

    def entry(self, key: str) -> Entry:
        for candidate in self.entries:
            if candidate.key == key:
                return candidate
        raise KeyError(
            f"{key!r} is not one of the {REQUIRED_COUNT} required documents "
            f"({', '.join(BY_KEY)})"
        )

    # -- recording --------------------------------------------------------
    def record(
        self,
        key: str,
        path: Path | str,
        *,
        status: str = GENERATED,
        sha256: str = "",
    ) -> Entry:
        """Record a produced document, and validate it on the spot."""
        entry = self.entry(key)
        path = Path(path)
        entry.generated_filename = path.name
        entry.location = str(path)
        entry.status = status
        entry.sha256 = sha256
        entry.bytes = path.stat().st_size if path.exists() else 0
        entry.validation, entry.detail, entry.page_count = validate_pdf(path)
        return entry

    def fail(self, key: str, reason: str) -> Entry:
        entry = self.entry(key)
        entry.status = FAILED
        entry.validation = MISSING
        entry.detail = reason
        return entry

    def add_additional(
        self, canonical_name: str, path: Path | str, source: str = "generated"
    ) -> Entry:
        path = Path(path)
        entry = Entry(
            key=path.stem,
            canonical_name=canonical_name,
            expected_filename=path.name,
            source=source,
            generated_filename=path.name,
            status=GENERATED if path.exists() else FAILED,
            validation=VALID if path.exists() else MISSING,
            location=str(path),
            bytes=path.stat().st_size if path.exists() else 0,
        )
        self.additional.append(entry)
        return entry

    # -- judging ----------------------------------------------------------
    @property
    def produced(self) -> list[Entry]:
        return [e for e in self.entries if e.ok]

    @property
    def shortfall(self) -> list[Entry]:
        return [e for e in self.entries if not e.ok]

    @property
    def complete(self) -> bool:
        return len(self.produced) == REQUIRED_COUNT and not self.duplicates()

    def duplicates(self) -> list[tuple[Entry, Entry]]:
        """Pairs where one document was filed as another.

        Two slots holding the same bytes means a route was walked twice, or a
        stale file was picked up under a second name. Either way the package
        looks complete and is not: somebody receives the Short Form twice and
        never learns the Long Form is missing.
        """
        pairs: list[tuple[Entry, Entry]] = []
        for index, first in enumerate(self.entries):
            if not first.sha256 or not first.ok:
                continue
            for second in self.entries[index + 1:]:
                if not second.ok:
                    continue
                if second.sha256 and second.sha256 == first.sha256:
                    pairs.append((first, second))
                elif (second.location and second.location == first.location):
                    pairs.append((first, second))
        return pairs

    def misfiled(self) -> list[str]:
        """Slots whose recorded file does not belong to that slot.

        The filename is the check: every expected filename is distinct, so a
        document written under another slot's expected name has been assigned
        the wrong type. Static assets are exempt -- their filename is fixed
        and carries no visit identifier.
        """
        problems: list[str] = []
        expected_names = {
            item.filename(self.site_visit): item.key for item in REQUIRED
        }
        for entry in self.entries:
            if not entry.generated_filename or not entry.ok:
                continue
            owner = expected_names.get(entry.generated_filename)
            if owner is not None and owner != entry.key:
                problems.append(
                    f"{entry.canonical_name} holds {entry.generated_filename!r}, "
                    f"which is {BY_KEY[owner].canonical_name}'s file"
                )
        return problems

    def filenames(self) -> list[str]:
        """The filenames, in package order, for the email body."""
        return [e.generated_filename or e.expected_filename for e in self.entries]

    def paths(self) -> list[Path]:
        return [Path(e.location) for e in self.entries if e.ok]

    def enforce(self) -> None:
        """Raise unless the package is complete, distinct and correctly filed.

        This is what makes "it said success with two documents" impossible.
        """
        problems: list[str] = []

        if len(self.produced) != REQUIRED_COUNT:
            problems.append(
                f"the package needs {REQUIRED_COUNT} documents and has "
                f"{len(self.produced)}. Not calling this finished."
            )
            for entry in self.shortfall:
                why = entry.detail or "no reason recorded"
                problems.append(f"  - {entry.canonical_name}: {entry.status}; {why}")

        for first, second in self.duplicates():
            second.validation = DUPLICATE
            problems.append(
                f"  - {second.canonical_name} is the same file as "
                f"{first.canonical_name} ({second.generated_filename}). One "
                "report has been filed as two."
            )

        for problem in self.misfiled():
            problems.append(f"  - {problem}")

        if problems:
            raise DeliverableError("\n".join(problems))

    # -- writing ----------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": 2,
            "site_visit": self.site_visit,
            "required": REQUIRED_COUNT,
            "produced": len(self.produced),
            "complete": self.complete,
            "documents": [e.to_dict() for e in self.entries],
            "additional": [e.to_dict() for e in self.additional],
        }

    def write(self, directory: Path | str) -> Path:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / MANIFEST_NAME
        path.write_text(
            json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return path

    @classmethod
    def load(cls, path: Path | str) -> "Manifest":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        manifest = cls(site_visit=str(data.get("site_visit", "")))
        manifest.entries = [Entry(**row) for row in data.get("documents", [])]
        manifest.additional = [Entry(**row) for row in data.get("additional", [])]
        return manifest

    # -- showing ----------------------------------------------------------
    def render(self) -> str:
        """The progress block the operator sees. One line per document."""
        lines = [f"  Documents for visit {self.site_visit or '(unknown)'}:"]
        for number, entry in enumerate(self.entries, start=1):
            state = "  OK  " if entry.ok else f"{entry.status:^6}"
            pages = f"{entry.page_count}p" if entry.page_count else ""
            lines.append(
                f"   [{number}/{REQUIRED_COUNT}] {state} {entry.canonical_name:<42} "
                f"{entry.generated_filename or entry.expected_filename} {pages}"
            )
            if not entry.ok and entry.detail:
                lines.append(f"            {entry.detail}")
        lines.append(
            f"   {len(self.produced)} of {REQUIRED_COUNT} required documents produced."
        )
        for entry in self.additional:
            lines.append(f"   plus  {entry.canonical_name}: {entry.generated_filename}")
        return "\n".join(lines)


def routes() -> Iterable[tuple[str, tuple[str, ...]]]:
    for item in REQUIRED:
        yield item.key, item.route


__all__ = [
    "REQUIRED", "REQUIRED_COUNT", "PORTAL_REQUIRED", "BY_KEY",
    "FINDINGS_SOURCE", "FINDINGS_CORROBORATION", "INVENTORY_PAIR",
    "MANIFEST_NAME", "FROM_STATIC", "FROM_DOCUMENT_LIBRARY", "FROM_ESA_REPORT",
    "PENDING", "GENERATED", "COPIED", "CONVERTED", "REUSED", "FAILED",
    "PRODUCED_STATUSES",
    "UNCHECKED", "VALID", "NOT_PDF", "EMPTY", "MISSING", "DUPLICATE",
    "DeliverableError", "Entry", "Expected", "Manifest", "validate_pdf", "routes",
]
