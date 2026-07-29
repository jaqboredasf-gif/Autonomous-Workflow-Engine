"""TEGG Pro portal automation (Playwright).

STATUS: SCAFFOLD -- NOT YET RUNNABLE AGAINST THE LIVE SITE.

The navigation structure below is transcribed directly from the SOP and is
believed correct. The CSS/text selectors that map each step onto real page
elements cannot be written without loading the site once, and tegg2.teggpro.com
is not reachable from the build environment. Every selector is therefore marked
with SELECTOR-TODO and `download_all` refuses to run until they are filled in.

Filling these in is roughly a one-hour job in front of the live site with
devtools open -- see docs/GAPS.md -> "Portal selectors".
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Job, Workflow, portal_credentials

SELECTOR_TODO = "SELECTOR-TODO"

# Each entry needs a real selector before the portal stage can run.
SELECTORS: dict[str, str] = {
    "username_input": SELECTOR_TODO,
    "password_input": SELECTOR_TODO,
    "login_button": SELECTOR_TODO,
    "login_success_marker": SELECTOR_TODO,
    "customer_search_input": SELECTOR_TODO,
    "site_dropdown": SELECTOR_TODO,
    "agreement_dropdown": SELECTOR_TODO,
    "site_visit_dropdown": SELECTOR_TODO,
    "contact_dropdown": SELECTOR_TODO,
    "order_by_dropdown": SELECTOR_TODO,
    "images_dropdown": SELECTOR_TODO,
    "record_selection_dropdown": SELECTOR_TODO,
    "format_dropdown": SELECTOR_TODO,
    "print_report_button": SELECTOR_TODO,
    "export_button": SELECTOR_TODO,
    "generate_document_button": SELECTOR_TODO,
}


class PortalError(Exception):
    """Raised when the portal stage cannot run or a download fails."""


def unresolved_selectors() -> list[str]:
    """Names of selectors that still need to be captured from the live site."""
    return sorted(k for k, v in SELECTORS.items() if v == SELECTOR_TODO)


@dataclass
class DownloadResult:
    key: str
    filename: str
    path: Path | None
    ok: bool
    error: str = ""


def preflight() -> list[str]:
    """Everything blocking a live portal run. Empty list means ready."""
    blockers = []

    missing = unresolved_selectors()
    if missing:
        blockers.append(
            f"{len(missing)} portal selector(s) not yet captured: "
            + ", ".join(missing[:5])
            + ("..." if len(missing) > 5 else "")
        )

    try:
        portal_credentials()
    except Exception as exc:
        blockers.append(str(exc))

    try:
        import playwright  # noqa: F401
    except ImportError:
        blockers.append("playwright is not installed (pip install playwright)")

    return blockers


def plan_downloads(workflow: Workflow, job: Job) -> list[dict[str, Any]]:
    """The exact click-path and dropdown values for each document.

    This runs without a browser, so the intended portal actions can be reviewed
    and signed off before anything is automated for real.
    """
    steps = []
    for document in workflow.documents:
        steps.append(
            {
                "key": document["key"],
                "filename": document["filename"],
                "format": document.get("format", "pdf"),
                "nav": document["nav"],
                "params": workflow.resolve_params(document, job),
                "action": document.get("action", "Print Report"),
            }
        )
    return steps


def download_all(workflow: Workflow, job: Job, out_dir: Path) -> list[DownloadResult]:
    """Log in and export every document defined in the workflow."""
    blockers = preflight()
    if blockers:
        raise PortalError(
            "portal automation is not ready to run:\n  - " + "\n  - ".join(blockers)
        )
    raise NotImplementedError(
        "Selectors are resolved but the Playwright driver body still needs to be "
        "written against the live DOM."
    )
