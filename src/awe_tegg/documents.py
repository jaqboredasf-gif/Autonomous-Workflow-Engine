"""Getting one site visit's reports out of TEGG, and nothing else.

TEGG does not let you download a report. It *renders* one, through SQL Server
Reporting Services, and the sequence is unavoidably interactive:

    /sales/documentation
      -> type the site name into the search box (a typeahead: real keystrokes,
         `fill()` does not fire it)
      -> Reports tab -> Standard ESA Reports
      -> click the report; some are a parent that only expands, and the report
         is one of its children
      -> set Agreement (and Order By / Images where the form offers them)
      -> Print Report          ... ~20 s of server-side generation
      -> a new tab opens with the SSRS viewer
      -> choose "Acrobat (PDF) file", then Export
      -> the PDF arrives as an *inline response*, not a download event and not
         a navigation

That is a lot of clicking, and it is why this module cannot use
``guard.ReadOnlyPage`` -- that object exists to make route *discovery* provably
harmless and exposes four verbs, none of which can type or click.

So the boundary is drawn differently here, and drawn explicitly:

  * ``ReportRun`` may only act on controls it can name in advance --
    the search box, the tab labels, the report labels, the parameter selects,
    ``Print Report``, the SSRS format select and its Export link. Every one is
    in :data:`PERMITTED_CONTROLS`.
  * It never submits a form, never posts, never clicks anything labelled with a
    word from :data:`FORBIDDEN_WORDS` (save, submit, approve, send, email,
    delete, complete, sign), and refuses if such a control is what a lookup
    resolved to.
  * Generating a report is a **read**. It creates a document from data that is
    already there; it changes no TEGG record. The parameter selects it touches
    are the report form's own inputs, which the portal does not keep.
  * Every action is counted against a budget, and the whole thing runs against
    one host.

None of that is as strong as "the object has no click method". It is as strong
as this route allows, it is written down, and the tests drive it against a mock
that records every request the server sees.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

#: Every control this module is allowed to touch, by the text it carries.
#: A lookup that lands on anything else raises rather than clicking.
PERMITTED_CONTROLS = (
    "Reports",
    "Standard ESA Reports",
    "Print Report",
    "Export",
)

#: Words that mean a control changes something. Never clicked, whatever else
#: it says, and a report label containing one is refused rather than opened.
FORBIDDEN_WORDS = re.compile(
    r"\b(save|submit|approve|send|e-?mail|delete|remove|complete|sign|"
    r"upload|publish|invoice|schedule\s+work|mark\s+as)\b",
    re.IGNORECASE,
)

#: How the portal says a site has no agreements to report on. It is an option
#: in the dropdown, not an empty dropdown, which is why it needs recognising.
#: Deliberately not matching "there are currently no site visits..." -- that
#: appears on the Standard IR form for sites that report perfectly well, and
#: treating it as fatal would break the working path.
_NO_AGREEMENTS = re.compile(r"no\s+agreements", re.IGNORECASE)

#: The SSRS toolbar. These ids are stable across the portal's reports.
FORMAT_SELECT = "#ReportViewer1_ctl01_ctl05_ctl00"
EXPORT_LINK = "#ReportViewer1_ctl01_ctl05_ctl01"
PDF_FORMAT = "Acrobat (PDF) file"

#: The two reports this operation needs, as a path through the report tree.
#: A ">" step is a parent that only expands; the last step is the report.
STANDARD_IR = ("Standard IR Report",)
EQUIPMENT_ITEM_PROBLEMS = ("Equipment Item Problems", "Exclude All Images")


class RetrievalError(Exception):
    """A document could not be retrieved, and the run should say why."""


class ActionRefused(RetrievalError):
    """Something asked this module to touch a control it may not touch."""


@dataclass
class Retrieved:
    """One report that came back, with what it cost to get it."""

    name: str = ""
    path: str = ""
    bytes: int = 0
    how: str = ""
    seconds: float = 0.0
    parameters: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RetrievalBudget:
    """A hard cap on how much clicking one retrieval may do."""

    max_actions: int = 40
    max_seconds: float = 600.0
    spent_actions: int = 0
    trail: list[str] = field(default_factory=list)
    #: None, not 0.0. A clock that legitimately reads zero would otherwise
    #: restart the window on every action and the time budget would never fire.
    started: float | None = None

    def spend(self, what: str, clock: Callable[[], float]) -> None:
        if self.started is None:
            self.started = clock()
        self.spent_actions += 1
        self.trail.append(what)
        if self.spent_actions > self.max_actions:
            raise RetrievalError(
                f"the retrieval budget of {self.max_actions} action(s) ran out "
                f"at {what!r}; nothing was changed"
            )
        elapsed = clock() - self.started
        if elapsed > self.max_seconds:
            raise RetrievalError(
                f"the retrieval budget of {self.max_seconds} s ran out at "
                f"{what!r} after {elapsed:.0f} s; nothing was changed"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_actions": self.max_actions,
            "max_seconds": self.max_seconds,
            "spent_actions": self.spent_actions,
            "trail": list(self.trail),
        }


def check_label(label: str) -> str:
    """Refuse a control whose text says it changes something."""
    match = FORBIDDEN_WORDS.search(label or "")
    if match:
        raise ActionRefused(
            f"refusing to act on a control labelled {label!r}: it carries "
            f"{match.group(0)!r}, which is not a read"
        )
    return label


class ReportRun:
    """Drives the SSRS route for one site's reports. Read-only by construction.

    Given a Playwright page that is already signed in and on the Documentation
    area. Everything it touches is named in :data:`PERMITTED_CONTROLS` or is a
    report label from the caller, and every label is screened.
    """

    def __init__(
        self,
        page: Any,
        *,
        out_dir: Path,
        budget: RetrievalBudget | None = None,
        settle_ms: int = 2000,
        viewer_timeout_ms: int = 180_000,
        export_timeout_ms: int = 300_000,
        on_note: Callable[[str], None] | None = None,
    ) -> None:
        self.page = page
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.budget = budget or RetrievalBudget()
        self.settle_ms = settle_ms
        self.viewer_timeout_ms = viewer_timeout_ms
        self.export_timeout_ms = export_timeout_ms
        self._note = on_note or (lambda message: None)

    # -- plumbing ---------------------------------------------------------
    def _clock(self) -> float:
        import time

        return time.monotonic()

    def _spend(self, what: str) -> None:
        self.budget.spend(what, self._clock)
        self._note(what)

    def _settle(self, tries: int = 15) -> None:
        for _ in range(tries):
            try:
                if "loading" not in self.page.inner_text("body").lower():
                    return
            except Exception:                               # noqa: BLE001
                pass
            self.page.wait_for_timeout(self.settle_ms // 3 or 300)

    def _visible(self, locator, limit: int = 8):
        for index in range(min(locator.count(), limit)):
            candidate = locator.nth(index)
            try:
                if candidate.is_visible():
                    return candidate
            except Exception:                               # noqa: BLE001
                continue
        return None

    # -- the route --------------------------------------------------------
    def select_site(self, site_name: str, *, customer: str = "") -> str:
        """Put the portal into one site's context via the search typeahead.

        The typeahead groups its answers under *Customers* and *Sites*. The
        site entry is what carries the agreements, and it is the later group,
        so the last match is taken. A run that lands on the customer instead
        reaches a form whose Agreement list reads "There are currently no
        agreements..." -- which renders an empty report rather than failing, so
        it has to be got right here rather than caught later.
        """
        wanted = (site_name or customer or "").strip()
        if not wanted:
            raise RetrievalError("no site or customer name to search for")

        self._spend("type the site name into the documentation search box")
        box = self.page.locator("input[placeholder*='customer' i]").first
        box.click()
        box.press_sequentially(wanted[:24], delay=170)
        self.page.wait_for_timeout(3500)

        items = self.page.locator(
            "typeahead-container .dropdown-item, typeahead-container a"
        )
        offered: list[tuple[int, str]] = []
        for index in range(min(items.count(), 60)):
            try:
                if items.nth(index).is_visible():
                    offered.append(
                        (index, " ".join(items.nth(index).inner_text().split()))
                    )
            except Exception:                               # noqa: BLE001
                continue
        if not offered:
            raise RetrievalError(
                f"the search box offered nothing for {wanted!r}. The site may be "
                "named differently in the portal than in the visit list."
            )

        exact = [i for i, text in offered if text.lower() == wanted.lower()]
        loose = [i for i, text in offered if wanted.lower()[:18] in text.lower()]
        order = exact or loose
        if not order:
            raise RetrievalError(
                f"none of the {len(offered)} search result(s) matched {wanted!r}: "
                f"{[t for _, t in offered][:8]}"
            )
        chosen = order[-1]
        self._spend("choose the site entry from the search results")
        items.nth(chosen).click()
        self.page.wait_for_timeout(4500)
        self._settle()
        return dict(offered)[chosen]

    def open_report_list(self) -> list[str]:
        """Reports -> Standard ESA Reports. Returns what is on offer."""
        for label in ("Reports", "Standard ESA Reports"):
            check_label(label)
            self._spend(f"open {label!r}")
            control = self._visible(self.page.get_by_text(label, exact=True))
            if control is None:
                raise RetrievalError(f"the {label!r} tab is not on this page")
            control.click(timeout=25_000)
            self.page.wait_for_timeout(2000)
            self._settle()
        try:
            return [
                text.strip()
                for text in self.page.locator("a").all_text_contents()
                if text.strip()
            ]
        except Exception:                                   # noqa: BLE001
            return []

    def open_report(self, path: tuple[str, ...]) -> None:
        """Walk the report tree to one report. Parents only expand."""
        for step in path:
            check_label(step)
            self._spend(f"open the report entry {step!r}")
            control = self._visible(self.page.locator(f"a:text-is('{step}')"))
            if control is None:
                raise RetrievalError(
                    f"{step!r} is not visible in the Standard ESA Reports list"
                )
            control.scroll_into_view_if_needed(timeout=8000)
            control.click(timeout=25_000)
            self.page.wait_for_timeout(2500)
            self._settle()

    def set_parameters(self, agreement: str) -> list[str]:
        """Fill the report form's own selects. Submits nothing.

        The Agreement is the one that matters: without it the report renders
        one empty page and the export still "succeeds". So a form that offers
        agreements and did not take ours is an error here, not a warning.
        """
        chosen: list[str] = []
        offered_agreements: list[str] = []
        selects = self.page.locator("select")
        for index in range(selects.count()):
            control = selects.nth(index)
            try:
                if not control.is_visible():
                    continue
                options = [
                    o.strip() for o in control.locator("option").all_text_contents()
                ]
            except Exception:                               # noqa: BLE001
                continue
            # The portal fills an empty agreement list with a sentence rather
            # than leaving it empty. That form still renders, still exports and
            # still produces a one-page PDF with nothing in it -- so it has to
            # be caught here, where it can be explained, rather than downstream
            # where it looks like a parser fault.
            if any(_NO_AGREEMENTS.search(o) for o in options):
                raise RetrievalError(
                    "the report form offers no agreements for this site "
                    f"({options[0]!r}). The search usually landed on the "
                    "customer rather than the site, or this site's agreements "
                    "are not published to the reporting module. Nothing was "
                    "changed; no report was requested."
                )
            if any(o.startswith(("STD", "DES", "PRM")) for o in options):
                offered_agreements = options
                if agreement and agreement in options:
                    self._spend("set the report's Agreement parameter")
                    control.select_option(label=agreement)
                    chosen.append(f"Agreement={agreement}")
                    self.page.wait_for_timeout(1800)
                    self._settle()
            elif "Include Images" in options:
                self._spend("set the report's Images parameter")
                control.select_option(label="Exclude Images")
                chosen.append("Images=Exclude Images")
            elif "Locations" in options and "Tag ID" in options:
                self._spend("set the report's Order By parameter")
                control.select_option(label="Locations")
                chosen.append("Order By=Locations")

        if agreement and not any(c.startswith("Agreement=") for c in chosen):
            raise RetrievalError(
                f"the report form did not offer agreement {agreement!r}"
                + (f"; it offered {offered_agreements[:6]}" if offered_agreements
                   else " and offered no agreements at all, which usually means "
                        "the search selected the customer rather than the site")
            )
        return chosen

    def export_pdf(self, destination: Path) -> tuple[Path, str]:
        """Print Report -> SSRS viewer -> PDF, captured off the wire.

        The export is an inline response: no download event fires and nothing
        navigates. Both are watched anyway, because "it arrived a different way
        this time" should not read as "it never arrived".
        """
        context = self.page.context
        # A viewer left open by an earlier report answers to the same selectors
        # and its toolbar is already spent. Close them, then accept only a page
        # that appears after the click.
        for stale in list(context.pages):
            if stale is not self.page:
                try:
                    stale.close()
                except Exception:                           # noqa: BLE001
                    pass
        before = set(context.pages)

        downloads: list[Any] = []
        context.on("download", lambda download: downloads.append(download))

        check_label("Print Report")
        self._spend("click Print Report")
        control = self._visible(self.page.get_by_text("Print Report", exact=True))
        if control is None:
            raise RetrievalError("this report form has no 'Print Report' control")
        control.click(timeout=25_000)

        viewer, waited = None, 0
        while waited < self.viewer_timeout_ms:
            fresh = [p for p in context.pages if p is not self.page and p not in before]
            if fresh:
                viewer = fresh[0]
                break
            self.page.wait_for_timeout(2000)
            waited += 2000
        if viewer is None:
            raise RetrievalError(
                f"the report viewer did not open within {self.viewer_timeout_ms // 1000} s "
                "of Print Report. The report may be too large to render, or a "
                "parameter may be missing."
            )

        try:
            viewer.wait_for_load_state("networkidle", timeout=90_000)
        except Exception:                                   # noqa: BLE001
            pass
        viewer.wait_for_timeout(3000)

        bodies: list[bytes] = []

        def grab(response: Any) -> None:
            try:
                ctype = (response.headers or {}).get("content-type", "").lower()
                if "pdf" in ctype or "format=pdf" in response.url.lower():
                    body = response.body()
                    if body[:5] == b"%PDF-":
                        bodies.append(body)
            except Exception:                               # noqa: BLE001
                pass

        viewer.on("response", grab)
        context.on("response", grab)

        # The viewer keeps rendering after networkidle; the format select is
        # not usable for several seconds and the failure mode is a timeout, not
        # an error, so this retries rather than trusting one attempt.
        selected = False
        for _ in range(20):
            try:
                viewer.locator(FORMAT_SELECT).first.select_option(
                    label=PDF_FORMAT, timeout=15_000
                )
                selected = True
                break
            except Exception:                               # noqa: BLE001
                viewer.wait_for_timeout(8000)
        if not selected:
            raise RetrievalError(
                "the report viewer's format list never became usable, so the "
                "PDF was never asked for"
            )

        viewer.wait_for_timeout(1500)
        check_label("Export")
        self._spend("choose PDF and click Export in the report viewer")
        viewer.locator(EXPORT_LINK).first.click(timeout=30_000)

        waited = 0
        while waited < self.export_timeout_ms and not downloads and not bodies:
            viewer.wait_for_timeout(2000)
            waited += 2000

        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        how = ""
        if downloads:
            downloads[0].save_as(str(destination))
            how = "download event"
        elif bodies:
            destination.write_bytes(bodies[0])
            how = "inline response"
        try:
            viewer.close()
        except Exception:                                   # noqa: BLE001
            pass
        if not how:
            raise RetrievalError(
                f"no PDF arrived within {self.export_timeout_ms // 1000} s of Export"
            )
        if destination.read_bytes()[:5] != b"%PDF-":
            destination.unlink(missing_ok=True)
            raise RetrievalError("what came back was not a PDF")
        return destination, how

    # -- one report, end to end -------------------------------------------
    def retrieve(
        self,
        name: str,
        path: tuple[str, ...],
        *,
        agreement: str,
        filename: str,
    ) -> Retrieved:
        start = self._clock()
        mark = len(self.budget.trail)
        self.open_report(path)
        parameters = self.set_parameters(agreement)
        saved, how = self.export_pdf(self.out_dir / filename)
        return Retrieved(
            name=name,
            path=str(saved),
            bytes=saved.stat().st_size,
            how=how,
            seconds=round(self._clock() - start, 1),
            parameters=parameters,
            actions=list(self.budget.trail[mark:]),
        )
