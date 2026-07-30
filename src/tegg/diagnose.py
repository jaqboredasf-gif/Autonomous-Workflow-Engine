"""Turning a failure message into the narrowest likely root cause.

A bounded repair loop is only useful if each failure points at one place to
look. "export failed" does not; "the format dropdown never became usable, so
look at the ReportViewer readiness poll" does.

The classification is a deliberate ladder, most specific first, and it is pure
text-in / verdict-out so every rule can be tested. It never guesses a fix -- it
names a stage, a likely locus, and whether the cause is more likely the code,
the fixture, or something genuinely outside this environment. Deciding what to
change stays with whoever reads it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Where the failure happened.
STAGE_LOGIN = "login"
STAGE_SITE = "site_selection"
STAGE_NAVIGATION = "report_navigation"
STAGE_PARAMETERS = "parameters"
STAGE_VIEWER = "report_viewer"
STAGE_EXPORT = "export"
STAGE_CONVERSION = "conversion"
STAGE_VALIDATION = "validation"
STAGE_ASSEMBLY = "assembly"
STAGE_UNKNOWN = "unknown"

# What is most likely at fault.
BLAME_CODE = "code"
BLAME_FIXTURE = "fixture"
BLAME_INPUT = "input"
BLAME_EXTERNAL = "external"
BLAME_UNKNOWN = "unknown"


@dataclass
class Diagnosis:
    """One failure, localised."""

    stage: str
    cause: str
    locus: str
    blame: str
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "stage": self.stage,
            "cause": self.cause,
            "locus": self.locus,
            "blame": self.blame,
            "detail": self.detail,
        }

    def __str__(self) -> str:
        return f"{self.stage}/{self.cause} -> {self.locus} ({self.blame})"


# (pattern, stage, cause, locus, blame). First match wins, so the most specific
# patterns come first.
RULES: tuple[tuple[str, str, str, str, str], ...] = (
    (
        r"credentials?\s+(are\s+)?(not set|missing)|TEGG_(USERNAME|PASSWORD)",
        STAGE_LOGIN, "credentials_absent",
        "environment: TEGG_USERNAME / TEGG_PASSWORD are unset",
        BLAME_EXTERNAL,
    ),
    (
        r"still on the sign-?in page|login did not complete",
        STAGE_LOGIN, "login_outcome_not_detected",
        "login.py: the post-submit outcome poll",
        BLAME_CODE,
    ),
    (
        r"invalid credentials|incorrect password|sign-?in was rejected",
        STAGE_LOGIN, "credentials_rejected",
        "the account itself -- rotate or re-check the password",
        BLAME_EXTERNAL,
    ),
    (
        r"contractor",
        STAGE_LOGIN, "contractor_not_set",
        "login.py: the required contractorConnection select",
        BLAME_CODE,
    ),
    (
        r"could not select the site|site .*not (found|visible)|no typeahead",
        STAGE_SITE, "site_not_selectable",
        "esaroute.select_site: the typeahead needs real keystrokes",
        BLAME_CODE,
    ),
    (
        r"PLEASE SEARCH FOR A CUSTOMER OR SITE",
        STAGE_SITE, "site_not_selected",
        "esaroute: a site must be selected before any tab renders",
        BLAME_CODE,
    ),
    (
        r"is not visible in the report list|no such report|report .*not found",
        STAGE_NAVIGATION, "report_leaf_not_found",
        "esaroute.click_report: accordion leaf lookup",
        BLAME_CODE,
    ),
    (
        r"currently no agreements",
        STAGE_NAVIGATION, "wrong_route",
        "the company-level /reports page is a dead end; use /sales/documentation",
        BLAME_CODE,
    ),
    (
        r"no control offers|has no option matching|required but no rule matched",
        STAGE_PARAMETERS, "parameter_unsatisfiable",
        "fieldmap.plan: the form does not offer this job's parameter",
        BLAME_INPUT,
    ),
    (
        r"no ReportViewer popup|viewer (tab )?never (appeared|opened)",
        STAGE_VIEWER, "viewer_never_opened",
        "ssrs.open_viewer: Print Report takes ~20s and opens a popup",
        BLAME_CODE,
    ),
    (
        r"format dropdown never became usable|Export Formats",
        STAGE_VIEWER, "format_dropdown_not_ready",
        "ssrs.export: the viewer keeps rendering after networkidle",
        BLAME_CODE,
    ),
    (
        r"no PDF (response|exported|arrived)|Print Report produced no PDF"
        r"|empty body",
        STAGE_EXPORT, "pdf_never_arrived",
        "ssrs.capture: the PDF is an inline response, not a download event",
        BLAME_CODE,
    ),
    (
        r"not a (readable )?PDF|does not start with %PDF|non-?pdf",
        STAGE_EXPORT, "response_was_not_a_pdf",
        "ssrs.capture: the body was served but is not a PDF -- read it, it is "
        "probably a server-side error page",
        BLAME_FIXTURE,
    ),
    (
        r"LibreOffice|soffice|could not convert|conversion failed",
        STAGE_CONVERSION, "conversion_failed",
        "certdoc: legacy .doc -> pdf via LibreOffice",
        BLAME_EXTERNAL,
    ),
    (
        r"checkbox|Wingdings|signature",
        STAGE_VALIDATION, "certificate_needs_a_human",
        "certdoc: section B checkboxes are Wingdings glyphs; never set them "
        "automatically",
        BLAME_EXTERNAL,
    ),
    (
        r"placeholder",
        STAGE_VALIDATION, "placeholder_left_in_output",
        "the template or the field mapping left a placeholder unfilled",
        BLAME_CODE,
    ),
    (
        r"does not name the (customer|site)|carries the date",
        STAGE_VALIDATION, "artifact_does_not_match_the_job",
        "naming.check / validate.text_contains -- wrong fixture or wrong job",
        BLAME_INPUT,
    ),
    (
        r"page count mismatch|contains no pages|could not be re-?opened",
        STAGE_ASSEMBLY, "assembled_pdf_invalid",
        "pipeline.build: the page-count invariant",
        BLAME_CODE,
    ),
    (
        r"missing \d+ document|cannot assemble|refusing to insert the same file",
        STAGE_ASSEMBLY, "sections_missing",
        "pipeline.collect: an earlier section never produced a file",
        BLAME_CODE,
    ),
    (
        r"static asset not found",
        STAGE_ASSEMBLY, "static_asset_missing",
        "assets/static/ -- the two fixed PDFs are supplied locally",
        BLAME_EXTERNAL,
    ),
    (
        r"timeout|timed out",
        STAGE_UNKNOWN, "timed_out",
        "a wait somewhere gave up; the message above names the selector",
        BLAME_UNKNOWN,
    ),
)

_COMPILED = tuple(
    (re.compile(pattern, re.IGNORECASE), stage, cause, locus, blame)
    for pattern, stage, cause, locus, blame in RULES
)


def diagnose(reason: str, *, stage_hint: str = "") -> Diagnosis:
    """Localise a failure message.

    ``stage_hint`` is used only when no rule matches, so a caller that knows
    which step it was running still gets a usefully narrow answer.
    """
    text = str(reason or "")
    for pattern, stage, cause, locus, blame in _COMPILED:
        match = pattern.search(text)
        if match:
            return Diagnosis(
                stage=stage,
                cause=cause,
                locus=locus,
                blame=blame,
                detail=text.strip()[:300],
            )
    return Diagnosis(
        stage=stage_hint or STAGE_UNKNOWN,
        cause="unclassified",
        locus="no rule matched; add one to diagnose.RULES once the cause is known",
        blame=BLAME_UNKNOWN,
        detail=text.strip()[:300],
    )
