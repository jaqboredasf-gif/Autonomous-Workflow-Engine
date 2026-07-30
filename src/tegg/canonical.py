"""Canonical report types, and the adapter that maps the portal to them.

The portal names things one way, the downloaded file lands with another name,
and the business order in the SOP uses a third. Matching any of those by exact
string is how this breaks in week two, so everything funnels through a small
set of canonical types defined here.

Classification is deliberately *evidence-based* rather than guess-based: a
label only classifies if it carries the tokens that distinguish that report
from its neighbours. "Equipment Inventory and Short Form" and "Equipment
Inventory and Long Form" differ by one word, so a rule that matched merely on
"inventory" would silently swap two sections of a customer-facing report.
Anything that matches two rules equally well is reported as ambiguous and left
for a human, never resolved by coin flip.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

# --- canonical types -------------------------------------------------------

COVER = "cover"
TABLE_OF_CONTENTS = "table_of_contents"
CERTIFICATE = "certificate"
PROBLEM_COUNT_SUMMARY = "problem_count_summary"
EQUIPMENT_INVENTORY_SHORT = "equipment_inventory_short"
EQUIPMENT_INVENTORY_LONG = "equipment_inventory_long"
STANDARD_IR = "standard_ir"
STANDARD_IR_NO_COVER = "standard_ir_no_cover"
EQUIPMENT_ITEM_PROBLEMS = "equipment_item_problems"
EDS_ALL_PROBLEMS = "eds_all_problems"
CUSTOMER_INSTRUCTIONS = "customer_instructions"

# How each type is obtained. This is what stops the pipeline from trying to
# download a cover that is actually cut out of another PDF.
SOURCE_PORTAL = "portal"
SOURCE_STATIC = "static"
SOURCE_DERIVED = "derived"

# The business order, exactly as the boss requires it.
BUSINESS_ORDER = [
    COVER,
    TABLE_OF_CONTENTS,
    CERTIFICATE,
    PROBLEM_COUNT_SUMMARY,
    EQUIPMENT_INVENTORY_SHORT,
    EQUIPMENT_INVENTORY_LONG,
    STANDARD_IR_NO_COVER,
    EQUIPMENT_ITEM_PROBLEMS,
    EDS_ALL_PROBLEMS,
    CUSTOMER_INSTRUCTIONS,
]


@dataclass(frozen=True)
class ReportType:
    key: str
    title: str
    source: str
    # Every group must contribute at least one hit for the rule to fire.
    required: tuple[tuple[str, ...], ...] = ()
    forbidden: tuple[str, ...] = ()
    filename: str = ""

    def score(self, text: str) -> int:
        """How strongly ``text`` matches. 0 means no match at all.

        The score is the combined length of the tokens that matched, so a rule
        matching "equipmentinventory" + "short" outranks one matching only
        "inventory". Length is a decent proxy for specificity and needs no
        hand-tuned weights.
        """
        for token in self.forbidden:
            if token in text:
                return 0
        total = 0
        for group in self.required:
            best = 0
            for token in group:
                if token in text:
                    best = max(best, len(token))
            if not best:
                return 0
            total += best
        return total


TYPES: tuple[ReportType, ...] = (
    ReportType(
        key=CERTIFICATE,
        title="Certificate",
        source=SOURCE_PORTAL,
        required=(("certificate", "certificates"),),
        filename="Certificates good.pdf",
    ),
    ReportType(
        key=PROBLEM_COUNT_SUMMARY,
        title="Problem Count Summary",
        source=SOURCE_PORTAL,
        required=(("problemcount", "count"), ("summary",)),
        # "EDS Component Problem Summary" also carries count-ish words.
        forbidden=("eds",),
        filename="ProblemCountSummary.pdf",
    ),
    ReportType(
        key=EQUIPMENT_INVENTORY_SHORT,
        title="Equipment Inventory Short Form",
        source=SOURCE_PORTAL,
        required=(("equipmentinventory", "inventory"), ("short",)),
        filename="EquipmentInventoryShortForm.pdf",
    ),
    ReportType(
        key=EQUIPMENT_INVENTORY_LONG,
        title="Equipment Inventory Long Form",
        source=SOURCE_PORTAL,
        required=(("equipmentinventory", "inventory"), ("long",)),
        filename="EquipmentInventoryLongForm.pdf",
    ),
    ReportType(
        key=STANDARD_IR,
        title="Standard IR Report",
        source=SOURCE_PORTAL,
        required=(("standardir", "ir", "infrared"),),
        # The split halves must never re-classify as the whole document.
        forbidden=("nocover",),
        filename="StandardIRReport.pdf",
    ),
    ReportType(
        key=EQUIPMENT_ITEM_PROBLEMS,
        title="Equipment Item Problems (All Images)",
        source=SOURCE_PORTAL,
        required=(("equipmentitemproblem", "itemproblem"),),
        filename="EquipmentItemProblem_AllImages.pdf",
    ),
    ReportType(
        key=EDS_ALL_PROBLEMS,
        title="EDS Component Problem Summary (All Problems)",
        source=SOURCE_PORTAL,
        required=(("eds",),),
        filename="EDSAllProblemsOnly.pdf",
    ),
    ReportType(
        key=TABLE_OF_CONTENTS,
        title="ESA Table of Contents",
        source=SOURCE_STATIC,
        required=(("tableofcontents", "contents"),),
        filename="ESA Table of Contents.pdf",
    ),
    ReportType(
        key=CUSTOMER_INSTRUCTIONS,
        title="TEGGPro View Customer Instructions",
        source=SOURCE_STATIC,
        required=(("customerinstruction", "instruction"),),
        filename="TEGGPro View Customer Instructions.pdf",
    ),
    ReportType(
        key=COVER,
        title="Cover (page 1 of the Standard IR Report)",
        source=SOURCE_DERIVED,
        required=(("cover",),),
        forbidden=("nocover", "withoutcover"),
        filename="Cover.pdf",
    ),
    ReportType(
        key=STANDARD_IR_NO_COVER,
        title="Standard IR Report without its cover",
        source=SOURCE_DERIVED,
        required=(("nocover", "withoutcover"),),
        filename="StandardIRReport no cover.pdf",
    ),
)

BY_KEY = {t.key: t for t in TYPES}

# What must be pulled from the portal for a complete report.
REQUIRED_PORTAL_TYPES = [t.key for t in TYPES if t.source == SOURCE_PORTAL]

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize(text: str) -> str:
    """Reduce a label or filename to comparable lowercase alphanumerics."""
    return _NON_ALNUM.sub("", str(text).lower())


@dataclass
class Classification:
    """The outcome of classifying one portal label or downloaded filename."""

    text: str
    key: str | None = None
    score: int = 0
    candidates: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.key is not None and not self.ambiguous

    @property
    def ambiguous(self) -> bool:
        return len(self.candidates) > 1

    def describe(self) -> str:
        if self.ambiguous:
            return f"{self.text!r}: AMBIGUOUS between {', '.join(self.candidates)}"
        if self.key is None:
            return f"{self.text!r}: no canonical type"
        return f"{self.text!r} -> {self.key}"


def classify(text: str) -> Classification:
    """Map a portal label or a downloaded filename to a canonical type.

    Returns a Classification rather than a bare string so the caller can tell
    "no match" apart from "matched two things equally well" -- those need very
    different handling and conflating them is how a report ends up with the
    long form in the short form's slot.
    """
    # A filename's extension and browser-added " (1)" suffix carry no signal.
    stem = Path(str(text)).stem
    stem = re.sub(r"\s*\(\d+\)\s*$", "", stem)
    haystack = normalize(stem)

    result = Classification(text=str(text))
    if not haystack:
        return result

    scored = [(t.score(haystack), t.key) for t in TYPES]
    scored = [(s, k) for s, k in scored if s > 0]
    if not scored:
        return result

    best = max(s for s, _ in scored)
    winners = sorted(k for s, k in scored if s == best)
    result.score = best
    result.candidates = winners
    if len(winners) == 1:
        result.key = winners[0]
    return result


def classify_many(texts: list[str]) -> dict[str, Classification]:
    """Classify several labels, keyed by the original text."""
    return {text: classify(text) for text in texts}


def output_filename(key: str) -> str:
    """The on-disk name a canonical type is stored under."""
    try:
        return BY_KEY[key].filename
    except KeyError:
        raise KeyError(f"unknown canonical report type: {key}") from None


def title(key: str) -> str:
    return BY_KEY[key].title if key in BY_KEY else key
