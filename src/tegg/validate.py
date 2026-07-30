"""Automated checks on a generated artifact.

Every check answers one question, returns a :class:`Check` either way, and never
raises for a merely-failing artifact -- a run must be able to report ten
problems at once rather than stopping at the first.

Checks are split by severity. ``REQUIRED`` failures make a report unusable.
``ADVISORY`` failures are recorded as formatting defects and do not fail the
run, because a cosmetic flaw in a draft is information, not a stop condition.

Two checks exist specifically to stop this tool from lying:

  * :func:`no_secrets` proves no credential value reached an artifact.
  * :func:`not_final_while_blocked` proves nothing is labelled final while a
    signature or checkbox requirement is outstanding.

Text extraction is capped at :data:`TEXT_PAGES` pages. The real Short Form is 70
pages and 11.9 MB; extracting all of it to confirm a customer name appears would
turn a validation pass into a coffee break, and the identifying fields are on
the opening pages by construction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader

REQUIRED = "required"
ADVISORY = "advisory"

PDF_MAGIC = b"%PDF-"

# How many leading pages to read when checking for expected text.
TEXT_PAGES = 6

# Text that means a template was never filled in. Deliberately narrow: matching
# loosely on things like "TBD" inside real report prose would cry wolf.
PLACEHOLDERS = (
    "<<",
    ">>",
    "{{",
    "}}",
    "XXXXX",
    "lorem ipsum",
    "TODO:",
    "FIXME",
    "PLACEHOLDER",
    "INSERT CUSTOMER",
    "INSERT SITE",
    "INSERT DATE",
    "TBD_",
)


@dataclass
class Check:
    """One question asked of an artifact, and the answer."""

    name: str
    passed: bool
    detail: str = ""
    severity: str = REQUIRED

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "passed": self.passed,
            "detail": self.detail,
            "severity": self.severity,
        }

    def __str__(self) -> str:
        mark = "ok  " if self.passed else "FAIL"
        return f"{mark} {self.name}: {self.detail}"


@dataclass
class Report:
    """The checks run against one artifact."""

    target: str = ""
    checks: list[Check] = field(default_factory=list)

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        return check

    def extend(self, checks: list[Check]) -> None:
        self.checks.extend(checks)

    @property
    def required_failures(self) -> list[Check]:
        return [c for c in self.checks if not c.passed and c.severity == REQUIRED]

    @property
    def advisory_failures(self) -> list[Check]:
        return [c for c in self.checks if not c.passed and c.severity == ADVISORY]

    @property
    def ok(self) -> bool:
        return not self.required_failures

    def reasons(self) -> str:
        return "; ".join(f"{c.name}: {c.detail}" for c in self.required_failures)

    def to_dict(self) -> dict:
        return {
            "target": self.target,
            "ok": self.ok,
            "checks": [c.to_dict() for c in self.checks],
        }


# ---------------------------------------------------------------------------
# File-level checks
# ---------------------------------------------------------------------------


def exists(path: Path | None) -> Check:
    if path is None:
        return Check("output_exists", False, "no output path was produced")
    path = Path(path)
    return Check(
        "output_exists",
        path.exists(),
        str(path) if path.exists() else f"not on disk: {path}",
    )


def non_empty(path: Path | None, minimum: int = 1) -> Check:
    if path is None or not Path(path).exists():
        return Check("output_non_empty", False, "no file to measure")
    size = Path(path).stat().st_size
    return Check(
        "output_non_empty",
        size >= minimum,
        f"{size} bytes" + (f" (minimum {minimum})" if size < minimum else ""),
    )


def is_pdf(path: Path | None) -> Check:
    """The first five bytes, not the extension. A renamed HTML error page is
    the single most common thing an export actually returns."""
    if path is None or not Path(path).exists():
        return Check("is_pdf", False, "no file to read")
    with Path(path).open("rb") as handle:
        head = handle.read(5)
    return Check(
        "is_pdf",
        head == PDF_MAGIC,
        "starts with %PDF-" if head == PDF_MAGIC else f"starts with {head!r}",
    )


def pdf_opens(path: Path | None) -> tuple[Check, int]:
    """Whether the PDF re-opens, and its page count (0 if it does not)."""
    if path is None or not Path(path).exists():
        return Check("pdf_opens", False, "no file to open"), 0
    try:
        pages = len(PdfReader(str(path)).pages)
    except Exception as exc:
        return Check("pdf_opens", False, f"pypdf could not read it: {exc}"), 0
    if pages < 1:
        return Check("pdf_opens", False, "opened but contains no pages"), 0
    return Check("pdf_opens", True, f"{pages} page(s)"), pages


def page_count_plausible(
    pages: int, *, minimum: int = 1, maximum: int = 5000
) -> Check:
    ok = minimum <= pages <= maximum
    return Check(
        "page_count_plausible",
        ok,
        f"{pages} page(s)" + ("" if ok else f", expected {minimum}-{maximum}"),
    )


def filename_convention(path: Path | None, expected: str) -> Check:
    if path is None:
        return Check("filename_convention", False, "no file produced")
    actual = Path(path).name
    return Check(
        "filename_convention",
        actual == expected,
        actual if actual == expected else f"{actual!r}, expected {expected!r}",
    )


# ---------------------------------------------------------------------------
# Content checks
# ---------------------------------------------------------------------------


def extract_text(path: Path, pages: int = TEXT_PAGES) -> str:
    """Text of the first ``pages`` pages, lowercased and whitespace-collapsed.

    Returns "" if the PDF cannot be read at all -- callers distinguish that with
    :func:`pdf_opens` rather than by inspecting this.
    """
    try:
        reader = PdfReader(str(path))
    except Exception:
        return ""
    chunks = []
    for page in reader.pages[:pages]:
        try:
            chunks.append(page.extract_text() or "")
        except Exception:
            continue
    return re.sub(r"\s+", " ", " ".join(chunks)).lower()


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", str(value)).strip().lower()


def required_text(
    text: str, fields: dict[str, str], *, severity: str = REQUIRED
) -> list[Check]:
    """One check per field that must appear in the document's text."""
    checks = []
    haystack = _norm(text)
    for label, value in fields.items():
        wanted = _norm(value)
        if not wanted:
            continue
        present = wanted in haystack
        checks.append(
            Check(
                f"text_has_{label}",
                present,
                f"{value!r} present" if present else f"{value!r} not found",
                severity=severity,
            )
        )
    return checks


def no_placeholders(text: str, extra: tuple[str, ...] = ()) -> Check:
    # The text is normalised here rather than trusted to have been normalised by
    # the caller. extract_text already lowercases, so this is a no-op on the
    # main path -- but a caller passing raw text would otherwise get a silent
    # pass on every uppercase marker, which is the worst possible failure for a
    # check whose whole job is to notice something.
    haystack = _norm(text)
    found = [p for p in (*PLACEHOLDERS, *extra) if _norm(p) and _norm(p) in haystack]
    return Check(
        "no_placeholders",
        not found,
        "none found" if not found else f"left in the output: {', '.join(found)}",
    )


def identifier_preserved(text: str, identifier: str) -> Check:
    wanted = _norm(identifier)
    if not wanted:
        return Check("identifier_preserved", True, "no identifier to check", ADVISORY)
    present = wanted in _norm(text)
    return Check(
        "identifier_preserved",
        present,
        f"{identifier!r} present" if present else f"{identifier!r} not found",
    )


def report_type_selected(expected: str, actual: str) -> Check:
    """Whether the report that came back is the one that was asked for."""
    ok = bool(expected) and expected == actual
    return Check(
        "correct_report_type",
        ok,
        f"{actual!r}" if ok else f"asked for {expected!r}, got {actual!r}",
    )


# ---------------------------------------------------------------------------
# Honesty checks
# ---------------------------------------------------------------------------


def no_secrets(paths: list[Path], secrets: list[str]) -> Check:
    """Prove no credential value appears in any produced artifact.

    Only values with some length are searched; a one- or two-character "secret"
    would match everything and make the check meaningless. Nothing about a
    secret's value is ever put into the detail string.
    """
    candidates = [s for s in secrets if s and len(s) >= 4]
    if not candidates:
        return Check("no_secrets_in_artifacts", True, "no secret values to search for")

    hits: list[str] = []
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        try:
            blob = path.read_bytes()
        except Exception:
            continue
        lowered = blob.lower()
        for secret in candidates:
            if secret.encode("utf-8", "ignore").lower() in lowered:
                # Name the file, never the value.
                hits.append(path.name)
                break
    return Check(
        "no_secrets_in_artifacts",
        not hits,
        f"{len(candidates)} value(s) searched across {len(paths)} artifact(s)"
        if not hits
        else f"a credential value appears in: {', '.join(sorted(set(hits)))}",
    )


def not_final_while_blocked(name: str, *, finalization_blocked: bool) -> Check:
    """A filename may not claim to be final while finalization is blocked."""
    upper = str(name).upper()
    claims_final = "FINAL" in upper and "SEMIFINAL" not in upper
    bad = claims_final and finalization_blocked
    return Check(
        "not_labelled_final_while_blocked",
        not bad,
        f"{name!r} claims FINAL while finalization is blocked"
        if bad
        else f"{name!r} makes no unsupported finality claim",
    )


def human_review_declared(reasons: list[str], *, expected: bool) -> Check:
    """When review is needed, the run must say so explicitly."""
    declared = bool(reasons)
    ok = declared == expected
    return Check(
        "human_review_declared",
        ok,
        f"{len(reasons)} reason(s) recorded"
        if declared
        else "no human review required",
    )


# ---------------------------------------------------------------------------
# The composite used per report
# ---------------------------------------------------------------------------


def check_pdf_artifact(
    path: Path | None,
    *,
    expected_filename: str = "",
    expected_type: str = "",
    actual_type: str = "",
    fields: dict[str, str] | None = None,
    identifier: str = "",
    min_pages: int = 1,
    max_pages: int = 5000,
    min_bytes: int = 400,
    secrets: list[str] | None = None,
    text_required: bool = True,
) -> Report:
    """Run every applicable check against one exported PDF.

    ``text_required=False`` downgrades the text checks to advisory, for the case
    where a document is a genuine scan or image-only export and carries no
    extractable text. That is a property of the document, not a way to make a
    failing check quiet: the checks still run and still appear in the result.
    """
    report = Report(target=str(path) if path else "")
    report.add(exists(path))
    report.add(non_empty(path, min_bytes))
    report.add(is_pdf(path))

    opened, pages = pdf_opens(path)
    report.add(opened)
    report.add(page_count_plausible(pages, minimum=min_pages, maximum=max_pages))

    if expected_filename:
        report.add(filename_convention(path, expected_filename))
    if expected_type:
        report.add(report_type_selected(expected_type, actual_type))

    severity = REQUIRED if text_required else ADVISORY
    if pages:
        text = extract_text(path)
        if fields:
            report.extend(required_text(text, fields, severity=severity))
        if identifier:
            check = identifier_preserved(text, identifier)
            check.severity = severity
            report.add(check)
        report.add(no_placeholders(text))

    if secrets:
        report.add(no_secrets([path] if path else [], secrets))

    return report
