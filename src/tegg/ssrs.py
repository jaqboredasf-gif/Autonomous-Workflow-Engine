"""Getting a PDF out of the portal's SQL Server Reporting Services viewer.

This is the half of the working live run that took longest to find, so the
reasoning is recorded here rather than left implicit in the code:

  * ``Print Report`` does **not** download. It takes about twenty seconds of
    server-side generation and then opens a **new tab** running an SSRS
    ReportViewer. There is no download event and no dialog.
  * The popup can take far longer than a default timeout to appear, so the tab
    is found by polling ``context.pages`` for a URL containing ``Report``.
  * The toolbar is the SOP's "Select a Format -> Export", with fixed control
    ids. **Order matters**: choose the format first. Clicking Export with no
    format selected does nothing at all.
  * The dropdown is not usable immediately after ``networkidle`` -- the viewer
    is still rendering -- so selecting the format is retried.
  * **The PDF arrives as an inline response.** Not a download event, not a
    navigation. ``expect_download()`` never fires and popup-watching never sees
    it. The only thing that works is a ``response`` listener on both the viewer
    and the context, keeping any body that begins with ``%PDF-``.
  * Never wrap a settle/poll inside ``expect_download()``: it consumes the whole
    timeout budget and starves the actual wait.

The magic-byte check is not belt-and-braces. A failed report is commonly served
as an HTML error page *with* ``Content-Type: application/pdf``, and without the
check that lands on disk as a plausible-looking .pdf that nothing can open.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

FORMAT_SELECT = "#ReportViewer1_ctl01_ctl05_ctl00"
EXPORT_LINK = "#ReportViewer1_ctl01_ctl05_ctl01"
PDF_FORMAT = "Acrobat (PDF) file"
PDF_MAGIC = b"%PDF-"

DIRECT_EXPORT_URL = (
    "{base}/Reserved.ReportViewerWebControl.axd"
    "?ReportSession={session}&ControlID={control}"
    "&Culture=1033&CultureOverrides=False&UICulture=9&UICultureOverrides=False"
    "&ReportStack=1&OpType=Export&FileName=report"
    "&ContentDisposition=AlwaysAttachment&Format=PDF"
)

SESSION_RE = re.compile(r"ReportSession=([^&\"'\s]+)")
CONTROL_RE = re.compile(r"ControlID=([^&\"'\s]+)")


class ExportError(Exception):
    """The export could not be completed."""


@dataclass
class PdfCatcher:
    """Collects inline PDF response bodies.

    Attached to the viewer page *and* its browser context, because which of the
    two sees the response depends on whether the export targets an iframe, a
    fetch, or a new window -- and that varies by SSRS version.
    """

    bodies: list[bytes] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)
    empty: list[str] = field(default_factory=list)
    inconclusive: list[str] = field(default_factory=list)
    seen: set[tuple[str, int]] = field(default_factory=set)

    def __call__(self, response) -> None:
        try:
            url = response.url or ""
            headers = response.headers or {}
            ctype = headers.get("content-type", "").lower()
            if "pdf" not in ctype and "format=pdf" not in url.lower():
                return
            declared = headers.get("content-length")
            body = response.body()
        except Exception:
            return

        # Whether this response *claims* to be a PDF, as opposed to merely
        # having a PDF-ish URL. Only the former can testify about the body.
        typed_as_pdf = "pdf" in ctype

        # Content-Length decides emptiness, not the body. When a response is
        # typed as a PDF, Chrome hands it to its internal viewer and
        # ``response.body()`` can come back as that viewer's HTML shell -- so a
        # zero-length export looks like a few hundred bytes of markup and gets
        # misdiagnosed as "the server sent an error page". SSRS and the mock
        # both set Content-Length, so the header is the honest signal.
        try:
            if declared is not None and int(declared) == 0:
                body = b""
        except (TypeError, ValueError):
            pass

        # This is attached to both the page and its context, so the same
        # response is delivered twice. De-duplicate, or every diagnosis reads
        # as if it happened twice.
        fingerprint = (url, len(body))
        if fingerprint in self.seen:
            return
        self.seen.add(fingerprint)

        where = f"{ctype or 'no content-type'} from {url[:120]}"
        if body[:5] == PDF_MAGIC:
            self.bodies.append(body)
        elif not typed_as_pdf:
            # Matched on the URL alone. Chrome re-reports the export URL for the
            # document its own PDF viewer renders, so this is the browser's
            # markup, not the server's answer. Recorded, never used as evidence
            # that the server sent the wrong thing.
            self.inconclusive.append(
                f"{where}: {len(body)} bytes, not typed as a PDF"
            )
        elif not body:
            # An empty body is not a wrong document, it is no document. The two
            # need different diagnoses: one points at the export, the other at
            # whatever generated the body.
            self.empty.append(f"{where}: empty body")
        else:
            # A non-PDF body on a PDF-typed response is a server-side error, and
            # its first bytes say which.
            self.rejected.append(
                f"{where}: {len(body)} bytes starting {body[:24]!r}"
            )

    def attach(self, viewer, context) -> None:
        viewer.on("response", self)
        context.on("response", self)

    def detach(self, viewer, context) -> None:
        for target in (viewer, context):
            try:
                target.remove_listener("response", self)
            except Exception:
                pass


def open_viewer(
    page,
    *,
    print_label: str = "Print Report",
    timeout_ms: int = 90000,
    poll_ms: int = 1000,
    url_marker: str = "Report",
):
    """Click Print Report and return the ReportViewer tab, or None.

    The popup listener has to be in place before the click, and the tab is then
    found by polling rather than by ``expect_popup``: generation takes about
    twenty seconds live, well past any default timeout.
    """
    context = page.context
    known = set(context.pages)
    appeared: list = []
    context.on("page", lambda p: appeared.append(p))

    page.get_by_text(print_label, exact=True).first.click(timeout=20000)

    waited = 0
    while waited < timeout_ms:
        for candidate in [*appeared, *context.pages]:
            if candidate is page or candidate in known:
                continue
            if url_marker.lower() in (candidate.url or "").lower():
                return candidate
        page.wait_for_timeout(poll_ms)
        waited += poll_ms
    return None


def select_pdf_format(
    viewer,
    *,
    selector: str = FORMAT_SELECT,
    label: str = PDF_FORMAT,
    attempts: int = 20,
    interval_ms: int = 1000,
) -> bool:
    """Choose "Acrobat (PDF) file", retrying while the viewer renders.

    The control exists in the DOM straight away but stays unusable, so a single
    attempt fails on a viewer that is merely still drawing.
    """
    for _ in range(attempts):
        try:
            viewer.locator(selector).first.select_option(label=label, timeout=3000)
            return True
        except Exception:
            viewer.wait_for_timeout(interval_ms)
    return False


def direct_export(viewer, destination: Path, base_url: str = "") -> Path | None:
    """Fetch the PDF straight from the export endpoint.

    The session and control ids live in the ReportViewer's **iframe URLs**, not
    in the top-level document.

    This path has never returned a PDF from the live portal. It is kept because
    it costs nothing to try after the toolbar route has already failed, but it
    is a hypothesis, not a working fallback.
    """
    try:
        html = viewer.content() + "".join(f.url for f in viewer.frames)
    except Exception:
        return None
    session = SESSION_RE.search(html)
    control = CONTROL_RE.search(html)
    if not (session and control):
        return None

    origin = base_url.rstrip("/")
    if not origin:
        parts = (viewer.url or "").split("/")
        origin = "/".join(parts[:3]) if len(parts) >= 3 else ""
    if not origin:
        return None

    url = DIRECT_EXPORT_URL.format(
        base=origin, session=session.group(1), control=control.group(1)
    )
    try:
        response = viewer.context.request.get(url, timeout=120000)
        if not response.ok:
            return None
        body = response.body()
    except Exception:
        return None
    if not body.startswith(PDF_MAGIC):
        return None
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)
    return destination


@dataclass
class ExportOutcome:
    """What the export produced, and how."""

    path: Path | None = None
    via: str = ""
    reason: str = ""
    viewer_url: str = ""
    rejected_bodies: list[str] = field(default_factory=list)
    empty_bodies: list[str] = field(default_factory=list)
    screenshots: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.path is not None

    def to_dict(self) -> dict:
        return {
            "path": str(self.path) if self.path else "",
            "via": self.via,
            "reason": self.reason,
            "viewer_url": self.viewer_url,
            "rejected_bodies": list(self.rejected_bodies),
            "empty_bodies": list(self.empty_bodies),
            "screenshots": list(self.screenshots),
        }


def export_pdf(
    page,
    destination: Path,
    *,
    evidence_dir: Path | None = None,
    tag: str = "report",
    base_url: str = "",
    print_label: str = "Print Report",
    viewer_timeout_ms: int = 90000,
    pdf_timeout_ms: int = 90000,
    poll_ms: int = 1000,
    close_viewer: bool = True,
) -> ExportOutcome:
    """The whole proven export: Print Report -> viewer -> format -> Export.

    Returns an :class:`ExportOutcome` either way rather than raising, because a
    report that will not export is a result to record, not an exception to
    unwind a ten-section run with.
    """
    destination = Path(destination)
    outcome = ExportOutcome()
    context = page.context

    viewer = open_viewer(
        page,
        print_label=print_label,
        timeout_ms=viewer_timeout_ms,
        poll_ms=poll_ms,
    )
    if viewer is None:
        outcome.reason = (
            "no ReportViewer popup appeared after Print Report was clicked"
        )
        return outcome

    outcome.viewer_url = viewer.url or ""
    try:
        viewer.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass

    def shoot(suffix: str) -> None:
        if evidence_dir is None:
            return
        try:
            path = Path(evidence_dir) / f"{tag}-{suffix}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            viewer.screenshot(path=str(path), full_page=True)
            outcome.screenshots.append(str(path))
        except Exception:
            pass

    shoot("viewer")

    # Listeners must be attached before the Export click; the response can come
    # back faster than a subsequent attach.
    catcher = PdfCatcher()
    catcher.attach(viewer, context)
    downloads: list = []
    context.on("download", lambda d: downloads.append(d))

    try:
        if not select_pdf_format(viewer):
            outcome.reason = (
                "the format dropdown never became usable, so Export was not "
                "clicked (clicking it without a format does nothing)"
            )
            shoot("viewer-no-format")
            return outcome

        viewer.wait_for_timeout(500)
        viewer.locator(EXPORT_LINK).first.click(timeout=25000)

        waited = 0
        while waited < pdf_timeout_ms and not downloads and not catcher.bodies:
            viewer.wait_for_timeout(poll_ms)
            waited += poll_ms

        destination.parent.mkdir(parents=True, exist_ok=True)
        if downloads:
            downloads[0].save_as(str(destination))
            outcome.path, outcome.via = destination, "download event"
        elif catcher.bodies:
            destination.write_bytes(catcher.bodies[0])
            outcome.path, outcome.via = destination, "inline response"
        else:
            saved = direct_export(viewer, destination, base_url)
            if saved is not None:
                outcome.path, outcome.via = saved, "direct export url"
    except Exception as exc:
        outcome.reason = f"export failed: {str(exc).splitlines()[0][:160]}"
    finally:
        outcome.rejected_bodies = list(catcher.rejected)
        outcome.empty_bodies = list(catcher.empty)
        catcher.detach(viewer, context)
        shoot("viewer-after")
        if close_viewer:
            try:
                viewer.close()
            except Exception:
                pass

    if outcome.path is None and not outcome.reason:
        if outcome.rejected_bodies:
            outcome.reason = (
                "the export responded but the body is not a PDF: "
                + "; ".join(outcome.rejected_bodies[:2])
            )
        elif outcome.empty_bodies:
            outcome.reason = (
                "no PDF arrived: the export responded with an empty body ("
                + "; ".join(outcome.empty_bodies[:2])
                + ")"
            )
        else:
            outcome.reason = (
                f"no PDF response arrived within {pdf_timeout_ms} ms of clicking "
                "Export"
            )
    return outcome
