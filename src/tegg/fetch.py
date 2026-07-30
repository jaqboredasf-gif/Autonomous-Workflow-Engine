"""Driving one live portal session into a job workspace.

Everything the browser does for a job happens here: sign in, find the completed
site visits, enter exactly one of them, take the certificate, and work out
where the reports really come from. Results go straight into the workspace
manifest as they happen, so a run that dies halfway leaves a resumable job
rather than a puzzle.

Read-only with respect to the portal. Nothing in this module submits a change,
marks anything complete, sends anything, or deletes anything.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import canonical, evidence, sitevisit, workspace as ws
from .config import portal_credentials
from .sitevisit import ExplorationError, Explorer, SiteVisit


class FetchError(Exception):
    """Raised when a portal session cannot be established at all."""


def preflight() -> list[str]:
    """Everything that must be true before a live run. Empty means ready."""
    blockers = []
    try:
        import playwright  # noqa: F401
    except ImportError:
        blockers.append(
            "playwright is not installed (pip install -e '.[portal]', then "
            "python -m playwright install chromium)"
        )
    try:
        portal_credentials()
    except Exception as exc:
        blockers.append(str(exc))
    return blockers


@contextmanager
def session(
    base_url: str,
    recorder: evidence.Recorder,
    settings: dict[str, Any],
    *,
    headless: bool = True,
    downloads: Path | None = None,
):
    """Open a logged-in portal session and guarantee the browser is closed."""
    blockers = preflight()
    if blockers:
        raise FetchError(
            "the portal stage is not ready to run:\n  - " + "\n  - ".join(blockers)
        )

    from playwright.sync_api import sync_playwright

    from .browser import launch

    username, password = portal_credentials()
    contractor = settings.get("contractor")

    with sync_playwright() as playwright:
        browser = launch(playwright, headless=headless)
        context = browser.new_context(accept_downloads=True)
        context.set_default_timeout(int(settings.get("timeout_ms", 30000)))
        page = context.new_page()
        try:
            explorer = Explorer(page, base_url, recorder, settings)
            explorer.login(username, password, contractor)
            yield explorer
        finally:
            try:
                context.close()
            finally:
                browser.close()


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


def list_completed(
    base_url: str,
    settings: dict[str, Any],
    evidence_dir: Path,
    *,
    headless: bool = True,
) -> list[SiteVisit]:
    """Log in and list the completed site visits. Read-only."""
    recorder = evidence.Recorder(evidence_dir)
    with session(base_url, recorder, settings, headless=headless) as explorer:
        explorer.open_documentation()
        return explorer.list_completed_site_visits()


# ---------------------------------------------------------------------------
# Fetching one job
# ---------------------------------------------------------------------------


@dataclass
class FetchReport:
    """What a portal run achieved, and what it could not."""

    visit: SiteVisit | None = None
    downloaded: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)
    discovered: list[sitevisit.DiscoveredDocument] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.downloaded or self.skipped) and not self.failed

    def summary(self) -> str:
        lines = []
        if self.visit:
            lines.append(f"site visit   {self.visit.describe()}")
        for key in self.downloaded:
            lines.append(f"  downloaded  {canonical.title(key)}")
        for key in self.skipped:
            lines.append(f"  have already  {canonical.title(key)}")
        for key, reason in self.failed.items():
            lines.append(f"  MISSING     {canonical.title(key)}: {reason}")
        return "\n".join(lines)


def fetch_job(
    workspace: ws.Workspace,
    base_url: str,
    settings: dict[str, Any],
    *,
    site_visit_id: str | None = None,
    headless: bool = True,
    force: bool = False,
) -> FetchReport:
    """Run the site-visit route for one job, recording everything it learns."""
    recorder = evidence.Recorder(workspace.evidence)
    report = FetchReport()

    with session(base_url, recorder, settings, headless=headless) as explorer:
        explorer.open_documentation()
        visits = explorer.list_completed_site_visits()

        if not visits:
            workspace.log_event(
                "portal", "no completed site visits could be identified"
            )
            raise FetchError(
                "no completed site visits were found in Documentation. The "
                f"evidence folder ({workspace.evidence}) holds the page "
                "snapshot and every link it offered -- send that along if the "
                "portal clearly does list them."
            )

        visit = _select(visits, site_visit_id)
        report.visit = visit
        workspace.data["site_visit"] = {
            "identifier": visit.identifier,
            "label": visit.label,
            "url": visit.url,
        }
        workspace.data["customer"] = workspace.data.get("customer") or visit.customer
        workspace.data["site"] = workspace.data.get("site") or visit.site
        workspace.data.setdefault("portal", {})["base_url"] = base_url
        workspace.save()

        explorer.open_site_visit(visit)
        report.actions = explorer.inventory_actions(f"visit-{visit.identifier}-actions")

        # -- the certificate, via the route that is known to work ----------
        if explorer.open_document_library():
            report.discovered = explorer.discover_documents()
            _fetch_certificate(explorer, workspace, report, force=force)
        else:
            report.failed[canonical.CERTIFICATE] = (
                "no Document Library was offered inside this site visit"
            )
            workspace.mark_failed(
                canonical.CERTIFICATE,
                "Document Library not offered in this site visit context",
                status=ws.UNAVAILABLE,
            )

        # -- the reports ---------------------------------------------------
        _fetch_reports(explorer, workspace, report, visit, force=force)

    recorder.flush()
    return report


def _select(visits: list[SiteVisit], site_visit_id: str | None) -> SiteVisit:
    """Pick exactly one visit. Ambiguity is an error, never a guess."""
    if site_visit_id:
        matches = [
            v for v in visits
            if site_visit_id in (v.identifier, v.date)
            or site_visit_id.lower() in v.label.lower()
        ]
        if not matches:
            available = ", ".join(v.identifier for v in visits[:12])
            raise FetchError(
                f"site visit {site_visit_id!r} was not in the completed list. "
                f"Available: {available}"
            )
        if len(matches) > 1:
            found = ", ".join(v.identifier for v in matches)
            raise FetchError(
                f"{site_visit_id!r} matched {len(matches)} site visits ({found}). "
                "Use the exact identifier."
            )
        return matches[0]

    if len(visits) > 1:
        listing = "\n".join(f"  {v.describe()}" for v in visits[:20])
        raise FetchError(
            f"{len(visits)} completed site visits are available and none was "
            f"chosen. Re-run with --site-visit <id>:\n{listing}"
        )
    return visits[0]


def _fetch_certificate(
    explorer: Explorer,
    workspace: ws.Workspace,
    report: FetchReport,
    *,
    force: bool,
) -> None:
    key = canonical.CERTIFICATE
    if not workspace.needs(key, force):
        report.skipped.append(key)
        return

    labels = list(
        explorer.settings.get("certificate_labels", ["Certificates", "Certificate"])
    )
    # Anything the discovery step already classified as the certificate is a
    # better trigger than a guess, so it goes first.
    for document in report.discovered:
        if document.canonical == key and document.label not in labels:
            labels.insert(0, document.label)

    last_error = "no certificate control was found in the Document Library"
    for label in labels:
        try:
            saved = explorer.download(
                label, workspace.source / "Certificates", step="download_certificate"
            )
        except ExplorationError as exc:
            last_error = str(exc)
            continue

        kind = sitevisit.verify_file_type(saved)
        if kind == "unknown":
            saved.unlink(missing_ok=True)
            last_error = (
                f"{label!r} returned something that is not a document "
                "(likely an HTML error page)"
            )
            continue

        record = workspace.mark_downloaded(
            key, saved, discovered_name=label, portal_url=explorer.page.url
        )
        record.validation = f"verified {kind}"
        workspace.put(record)
        report.downloaded.append(key)
        return

    report.failed[key] = last_error
    workspace.mark_failed(key, last_error, status=ws.UNAVAILABLE)


def _fetch_reports(
    explorer: Explorer,
    workspace: ws.Workspace,
    report: FetchReport,
    visit: SiteVisit,
    *,
    force: bool,
) -> None:
    """Locate and download the job-specific reports for this site visit.

    Discovery-led: the portal's own labels are classified, and only a label
    that classifies unambiguously is acted on. A report we cannot find is
    recorded with the reason rather than substituted with a guess.
    """
    wanted = [k for k in canonical.REQUIRED_PORTAL_TYPES if k != canonical.CERTIFICATE]

    # Re-discover in the current context; the Document Library may not be where
    # the reports live.
    discovered = {d.canonical: d for d in explorer.discover_documents() if d.canonical}
    for document in report.discovered:
        discovered.setdefault(document.canonical, document)

    routes = explorer.settings.get("report_routes") or []
    for route in routes:
        try:
            from .portal import find_link

            find_link(explorer.page, route).click()
            explorer.page.wait_for_load_state("domcontentloaded")
            explorer.guard_session("report_route")
            for document in explorer.discover_documents():
                if document.canonical:
                    discovered.setdefault(document.canonical, document)
        except Exception:
            continue

    for key in wanted:
        if not workspace.needs(key, force):
            report.skipped.append(key)
            continue

        document = discovered.get(key)
        if document is None:
            reason = (
                "no control in the site-visit context classified as this report"
            )
            report.failed[key] = reason
            workspace.mark_failed(key, reason, status=ws.UNAVAILABLE)
            continue

        try:
            saved = explorer.download(
                document.label,
                workspace.source / canonical.output_filename(key),
                step=f"download_{key}",
            )
        except ExplorationError as exc:
            report.failed[key] = str(exc)
            workspace.mark_failed(key, str(exc), status=ws.UNAVAILABLE)
            continue

        kind = sitevisit.verify_file_type(saved)
        if kind != "pdf":
            saved.unlink(missing_ok=True)
            reason = f"{document.label!r} returned {kind}, expected a PDF"
            report.failed[key] = reason
            workspace.mark_failed(key, reason, status=ws.FAILED)
            continue

        record = workspace.mark_downloaded(
            key, saved, discovered_name=document.label, portal_url=explorer.page.url
        )
        record.validation = "verified pdf"
        workspace.put(record)
        report.downloaded.append(key)
