"""Site-visit-centric portal exploration.

The original driver assumed a company-level Reports screen. On the real portal
that screen reports "currently no agreements", so it is the wrong entry point.
The route that actually works is the one a human uses:

    Documentation -> a completed site visit -> Document Library -> Certificates

Everything here is built around that. The explorer's job on a first live run is
not to succeed at all costs, it is to *find out what is there* and write it
down: every page reached, every action offered, every reason something was not
available. A run that discovers the portal looks nothing like we expected is a
successful run, provided it says so precisely.

Two rules the code holds to:

  * Fail closed. If the page identity or the selected site visit is uncertain,
    stop and record why. Never continue on the assumption that a page is what
    we hoped.
  * Never fabricate a download. A file only counts when bytes landed on disk
    and were verified to be the type expected.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import evidence
from .portal import PortalError, find_button, find_link

# The portal's Status column values that mean "ready to report on". Matched
# exactly, because "Incomplete" contains "complete" and must never qualify.
COMPLETED_STATUSES = {"completed", "complete", "closed", "finished"}


def _first(fields: dict[str, str], *names: str) -> str:
    """First matching column value, by exact header then by substring."""
    for name in names:
        if name in fields:
            return fields[name]
    for name in names:
        for head, value in fields.items():
            if name in head:
                return value
    return ""


# Text that marks a completed visit, and text that marks one that is not.
COMPLETED_MARKERS = ("complete", "completed", "closed", "finished")
INCOMPLETE_MARKERS = ("in progress", "incomplete", "scheduled", "open", "pending")

DATE_PATTERN = re.compile(
    r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b"
)
# Identifiers as they usually appear in a portal URL.
ID_IN_URL = re.compile(
    r"(?:id|visitid|sitevisitid|svid|key)=([A-Za-z0-9._-]+)", re.IGNORECASE
)
ID_IN_PATH = re.compile(r"/(\d{3,})(?:/|$)")

PDF_MAGIC = b"%PDF-"
OLE_MAGIC = b"\xd0\xcf\x11\xe0"  # legacy .doc
ZIP_MAGIC = b"PK\x03\x04"  # .docx


class ExplorationError(PortalError):
    """A portal exploration step failed. Carries an outcome classification."""

    def __init__(self, message: str, outcome: str = evidence.UNEXPECTED_STRUCTURE):
        super().__init__(message)
        self.outcome = outcome


@dataclass
class SiteVisit:
    """One completed site visit as listed by the portal."""

    identifier: str
    label: str = ""
    customer: str = ""
    site: str = ""
    date: str = ""
    url: str = ""
    row_text: str = ""
    agreement: str = ""
    job_number: str = ""
    technician: str = ""
    start_date: str = ""
    end_date: str = ""
    status: str = ""

    def describe(self) -> str:
        bits = [f"[{self.identifier}]"]
        if self.customer:
            bits.append(self.customer)
        if self.site and self.site != self.customer:
            bits.append(self.site)
        if self.end_date:
            bits.append(f"completed {self.end_date}")
        elif self.date:
            bits.append(self.date)
        if self.technician and self.technician.upper() != "N/A":
            bits.append(f"tech {self.technician}")
        if self.agreement:
            bits.append(self.agreement)
        if not self.customer and not self.site and self.label:
            bits.append(self.label[:70])
        return "  ".join(bits)

    def to_dict(self) -> dict[str, Any]:
        return {
            "identifier": self.identifier,
            "label": self.label,
            "customer": self.customer,
            "site": self.site,
            "date": self.date,
            "url": self.url,
            "agreement": self.agreement,
            "job_number": self.job_number,
            "technician": self.technician,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "status": self.status,
        }


@dataclass
class DiscoveredDocument:
    """Something the portal offers that may be one of our required documents."""

    label: str
    canonical: str | None = None
    href: str = ""
    ambiguous_between: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "canonical": self.canonical,
            "href": self.href,
            "ambiguous_between": list(self.ambiguous_between),
        }


class Explorer:
    """Drives one logged-in session around the site-visit route."""

    def __init__(
        self,
        page,
        base_url: str,
        recorder: evidence.Recorder,
        settings: dict[str, Any] | None = None,
        keep_all_statuses: bool = False,
    ) -> None:
        self.page = page
        self.base_url = base_url.rstrip("/")
        self.recorder = recorder
        self.settings = settings or {}
        # False keeps the long-standing behaviour: only Completed visits are
        # returned, because that is all the fetch path can act on. True returns
        # every row so a caller can classify the list and decide what is safe
        # to write to.
        self.keep_all_statuses = keep_all_statuses

    # -- session ----------------------------------------------------------
    def login(self, username: str, password: str, contractor: str | None = None) -> None:
        """Log in. Credentials come from the environment and are never logged.

        The form is located by structure rather than by one assumed label --
        see ``tegg.login``. The first live attempt failed because the page
        labels its username field "Please enter email address/username", not
        "User Id", and its button "Sign in", not "Log In".
        """
        from . import login as login_module

        login_path = self.settings.get("login_path", "/auth/login")
        self.page.goto(f"{self.base_url}{login_path}", wait_until="domcontentloaded")
        try:
            self.page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass

        labels = self.settings.get("login_labels", {})

        try:
            form = login_module.locate(self.page, labels)
        except login_module.LoginFormError as exc:
            # The structure dump is the whole point of this failure path.
            artifacts = self.recorder.capture(self.page, "login-form-not-found")
            artifacts += login_module.probe(self.page, self.recorder.directory).artifacts
            self.recorder.note(
                "login", evidence.UNEXPECTED_STRUCTURE, str(exc).splitlines()[0],
                url=self.page.url, artifacts=artifacts,
            )
            raise ExplorationError(
                f"the sign-in form could not be located: {exc}",
                evidence.UNEXPECTED_STRUCTURE,
            ) from exc

        self.recorder.note(
            "login_form", evidence.AVAILABLE, form.describe(), url=self.page.url
        )

        # The live portal marks its contractor picker `required`, so the form
        # will not submit until it is set -- and the failure looks like a
        # credential problem if it is skipped. Fail closed instead.
        if form.contractor is not None:
            if not contractor:
                if form.contractor_required:
                    raise ExplorationError(
                        "this portal requires a contractor to be chosen before "
                        "sign-in, but none is configured. Set portal.contractor "
                        "in config/workflow.yaml to one of: "
                        + ", ".join(form.contractor_options[:12]),
                        evidence.UNEXPECTED_STRUCTURE,
                    )
            else:
                try:
                    chosen = form.select_contractor(contractor)
                except login_module.LoginFormError as exc:
                    self.recorder.note(
                        "login_contractor", evidence.UNEXPECTED_STRUCTURE, str(exc),
                        url=self.page.url,
                    )
                    raise ExplorationError(str(exc), evidence.UNEXPECTED_STRUCTURE) from exc
                self.recorder.note(
                    "login_contractor", evidence.AVAILABLE,
                    f"contractor {contractor!r} -> {chosen!r}", url=self.page.url,
                )
        elif contractor:
            self.recorder.note(
                "login_contractor", evidence.UNAVAILABLE,
                f"no contractor control found; continuing without {contractor!r}",
                url=self.page.url,
            )

        # Any further values this portal demands (company code, account id...).
        extra = self.settings.get("extra_fields") or {}
        if extra:
            try:
                names = login_module.fill_extra_fields(form.frame, extra)
            except login_module.LoginFormError as exc:
                raise ExplorationError(str(exc), evidence.UNEXPECTED_STRUCTURE) from exc
            self.recorder.note(
                "login_extra_fields", evidence.AVAILABLE,
                f"filled {', '.join(names)}", url=self.page.url,
            )

        try:
            cookies_before = [c["name"] for c in self.page.context.cookies()]
        except Exception:
            cookies_before = []

        # Record the sign-in request's status and redirect chain. Only URLs and
        # status codes -- never request bodies, which carry the password.
        responses: list[dict[str, Any]] = []

        def _on_response(response) -> None:
            try:
                if response.request.method == "POST" or "login" in response.url.lower():
                    responses.append(
                        {"status": response.status, "url": response.url.split("?")[0]}
                    )
            except Exception:
                pass

        self.page.on("response", _on_response)

        form.username.fill(username)
        form.password.fill(password)

        if form.submit is not None:
            form.submit.click()
        else:
            form.password.press("Enter")

        # An Angular sign-in triggers no navigation, so waiting on a load state
        # returns instantly and any check made here would always see the form
        # still present. Poll for a real outcome instead.
        outcome = login_module.wait_for_result(
            self.page,
            login_path,
            timeout_ms=int(self.settings.get("login_timeout_ms", 30000)),
            cookies_before=cookies_before,
        )
        try:
            self.page.remove_listener("response", _on_response)
        except Exception:
            pass

        if not outcome.ok:
            # Blank the fields before any snapshot, so the username cannot
            # reach a screenshot, and redact it from saved HTML.
            self._clear_credentials()
            artifacts = self.recorder.capture(self.page, "login-failed")
            self._redact_artifacts(artifacts, username)
            self.recorder.note(
                "login",
                evidence.SESSION_EXPIRED
                if outcome.reason == "no_response"
                else evidence.PERMISSION,
                f"{outcome.reason}: {outcome.detail}",
                url=outcome.url,
                artifacts=artifacts,
                responses=responses[-8:],
                extra_fields=outcome.extra_fields,
                waited_ms=outcome.waited_ms,
            )
            raise ExplorationError(
                _login_failure_message(outcome, responses),
                evidence.PERMISSION,
            )

        self.recorder.note(
            "login_result", evidence.AVAILABLE,
            f"{outcome.reason} after {outcome.waited_ms} ms",
            url=outcome.url, responses=responses[-8:],
            new_cookies=outcome.new_cookies,
        )

        artifacts = self.recorder.capture(self.page, "logged-in")
        self.recorder.note(
            "login", evidence.AVAILABLE, "signed in",
            url=self.page.url, artifacts=artifacts,
        )

    def _clear_credentials(self) -> None:
        """Blank every input before a failure snapshot is taken.

        A screenshot of a failed sign-in would otherwise carry the username in
        plain view, and the HTML snapshot could carry both.
        """
        try:
            self.page.eval_on_selector_all(
                "input",
                "els => els.forEach(e => { "
                "if (e.type !== 'checkbox' && e.type !== 'radio') e.value = ''; })",
            )
        except Exception:
            pass

    def _redact_artifacts(self, artifacts: list[str], *secrets: str) -> None:
        """Scrub credential values out of saved HTML and JSON evidence."""
        from . import login as login_module

        for name in artifacts:
            path = self.recorder.directory / name
            if path.suffix not in (".html", ".json"):
                continue
            try:
                original = path.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            cleaned = login_module.redact(original, *secrets)
            if cleaned != original:
                try:
                    path.write_text(cleaned, encoding="utf-8")
                except Exception:
                    pass

    def _visible_error(self) -> str:
        """Whatever the page says went wrong, for the operator's message."""
        for selector in (
            "[role=alert]",
            ".alert",
            ".error",
            ".invalid-feedback",
            ".validation-summary-errors",
        ):
            try:
                locator = self.page.locator(selector).first
                if locator.count() and locator.is_visible():
                    text = (locator.inner_text() or "").strip()
                    if text:
                        return text[:200].replace("\n", " ")
            except Exception:
                continue
        return ""

    def _shows_login_form(self) -> bool:
        login_path = self.settings.get("login_path", "/auth/login")
        if login_path and login_path in self.page.url:
            return True
        try:
            return self.page.locator("input[type=password]").count() > 0
        except Exception:
            return False

    def guard_session(self, step: str) -> None:
        """Fail closed if the session dropped or the page says we cannot be here."""
        if self._shows_login_form():
            artifacts = self.recorder.capture(self.page, f"{step}-session-expired")
            self.recorder.note(
                step, evidence.SESSION_EXPIRED, "returned to the sign-in page",
                url=self.page.url, artifacts=artifacts,
            )
            raise ExplorationError(
                "the portal session expired mid-run; re-run to resume",
                evidence.SESSION_EXPIRED,
            )

        outcome = evidence.classify_page_text(self._text())
        if outcome in (evidence.PERMISSION, evidence.SESSION_EXPIRED):
            artifacts = self.recorder.capture(self.page, f"{step}-{outcome}")
            self.recorder.note(
                step, outcome, "portal reported a permission or session problem",
                url=self.page.url, artifacts=artifacts,
            )
            raise ExplorationError(
                f"the portal refused this step ({outcome})", outcome
            )

    def _text(self) -> str:
        try:
            return self.page.inner_text("body")
        except Exception:
            return ""

    # -- documentation ----------------------------------------------------
    def open_documentation(self) -> None:
        """Reach the Documentation area, where completed site visits live."""
        path = self.settings.get("documentation_path")
        opened = False
        if path:
            self.page.goto(f"{self.base_url}{path}", wait_until="domcontentloaded")
            opened = True
        else:
            for label in self.settings.get("documentation_labels", ["Documentation"]):
                try:
                    find_link(self.page, label).click()
                    self.page.wait_for_load_state("domcontentloaded")
                    opened = True
                    break
                except PortalError:
                    continue

        artifacts = self.recorder.capture(self.page, "documentation")
        if not opened:
            self.recorder.note(
                "open_documentation", evidence.UNEXPECTED_STRUCTURE,
                "no Documentation link found",
                url=self.page.url, artifacts=artifacts,
            )
            raise ExplorationError(
                "could not find a Documentation link. The evidence folder lists "
                "every link the page offers -- set portal.documentation_path in "
                "config/workflow.yaml to the right one.",
                evidence.UNEXPECTED_STRUCTURE,
            )

        self.guard_session("open_documentation")

        # The visit table arrives from a later API call, so wait for it before
        # anything tries to read the page.
        loaded = self.wait_for_content()
        timeframe = self.settings.get("visit_timeframe")
        if timeframe:
            if self.set_timeframe(timeframe):
                self.recorder.note(
                    "set_timeframe", evidence.AVAILABLE, f"timeframe {timeframe!r}",
                    url=self.page.url,
                )
            else:
                self.recorder.note(
                    "set_timeframe", evidence.UNAVAILABLE,
                    f"no timeframe option {timeframe!r} on this page",
                    url=self.page.url,
                )

        artifacts = self.recorder.capture(self.page, "documentation-loaded")
        self.recorder.note(
            "open_documentation",
            evidence.AVAILABLE if loaded else evidence.UNEXPECTED_STRUCTURE,
            "documentation area open" if loaded else "visit table never finished loading",
            url=self.page.url, artifacts=artifacts,
        )

    # -- listing ----------------------------------------------------------
    def list_completed_site_visits(self) -> list[SiteVisit]:
        """Enumerate completed site visits from whatever structure is present.

        Tables first, since portals of this vintage use them; links as a
        fallback. Anything found is written to evidence either way, so a run
        that finds nothing still tells us what the page contained.
        """
        self.guard_session("list_site_visits")
        visits = self._visits_from_tables()
        if not visits:
            visits = self._visits_from_links()

        artifacts = self.recorder.capture(self.page, "site-visit-list")
        if not visits:
            outcome = (
                evidence.classify_page_text(self._text())
                or evidence.UNEXPECTED_STRUCTURE
            )
            self.recorder.note(
                "list_site_visits", outcome,
                "no completed site visits could be identified",
                url=self.page.url, artifacts=artifacts,
            )
            return []

        self.recorder.note(
            "list_site_visits", evidence.AVAILABLE,
            f"{len(visits)} completed site visit(s)",
            url=self.page.url, artifacts=artifacts,
            visits=[v.to_dict() for v in visits],
        )
        return visits

    # The site-visit table, read by column name rather than by position.
    _ROWS_JS = """
    () => {
      const out = [];
      document.querySelectorAll('table').forEach(t => {
        const heads = Array.from(t.querySelectorAll('th'))
            .map(h => (h.innerText || '').trim());
        // The live portal heads this column "Site Name"; other layouts use
        // just "Site". Accept either, or a Status column, so a stricter match
        // cannot silently yield zero rows.
        if (!heads.some(h => /site\\s*name|^\\s*site\\s*$|^\\s*status\\s*$/i.test(h))) return;
        t.querySelectorAll('tbody tr').forEach(r => {
          const cells = Array.from(r.querySelectorAll('td'))
              .map(c => (c.innerText || '').trim());
          if (!cells.length) return;
          const link = r.querySelector('a[href]');
          out.push({
            heads: heads,
            cells: cells,
            href: link ? link.getAttribute('href') : '',
            text: (r.innerText || '').trim()
          });
        });
      });
      return out;
    }
    """

    def wait_for_content(self, tries: int = 30, interval_ms: int = 1000) -> bool:
        """Wait for the Angular table to finish loading.

        The page renders "Loading site visits..." and fills the table from an
        API call afterwards, so a scan made at domcontentloaded sees nothing.
        This is what made the first live run report zero completed visits when
        the portal in fact had 180.
        """
        saw_loading = False
        for attempt in range(tries):
            try:
                text = self.page.inner_text("body")
            except Exception:
                text = ""
            if "loading" in text.lower():
                saw_loading = True
            else:
                try:
                    if self.page.evaluate(self._ROWS_JS):
                        return True
                except Exception:
                    pass
                # A page that never showed a loading indicator and has no rows
                # is not slow, it is the wrong page. Waiting out the full budget
                # on it turns a clear misconfiguration into an apparent hang.
                if not saw_loading and attempt >= 2:
                    return False
            self.page.wait_for_timeout(interval_ms)
        return bool(self._raw_rows())

    def set_timeframe(self, label: str) -> bool:
        """Widen the visit list's timeframe, e.g. to "All Site Visits"."""
        try:
            selects = self.page.locator("select")
            for index in range(selects.count()):
                control = selects.nth(index)
                options = [
                    o.strip() for o in control.locator("option").all_text_contents()
                ]
                if label in options:
                    control.select_option(label=label)
                    self.page.wait_for_timeout(1500)
                    self.wait_for_content()
                    return True
        except Exception:
            pass
        return False

    def _raw_rows(self) -> list[dict[str, Any]]:
        try:
            return self.page.evaluate(self._ROWS_JS)
        except Exception:
            return []

    def _visits_from_tables(self) -> list[SiteVisit]:
        """Read the visit table across every page of results."""
        visits: list[SiteVisit] = []
        pages_read = 0
        max_pages = int(self.settings.get("max_list_pages", 20))

        while pages_read < max_pages:
            visits.extend(self._visits_on_this_page())
            pages_read += 1
            if not self._go_to_next_page():
                break

        self.recorder.note(
            "list_pagination", evidence.AVAILABLE,
            f"read {pages_read} page(s) of the visit list", url=self.page.url,
        )
        return self._dedupe(visits)

    def _visits_on_this_page(self) -> list[SiteVisit]:
        visits = []
        for row in self._raw_rows():
            heads = [h.lower() for h in (row.get("heads") or [])]
            cells = row.get("cells") or []
            # A leading checkbox/icon column shifts every value along by one.
            if len(cells) == len(heads) + 1:
                cells = cells[1:]
            field_of = {}
            for index, head in enumerate(heads):
                if index < len(cells):
                    field_of[head] = cells[index]

            status = _first(field_of, "status")
            # ``keep_all_statuses`` is what lets a caller *classify* the list --
            # Draft, In Progress, Completed -- rather than only see the finished
            # rows. The default is unchanged, so the fetch path still sees
            # exactly what it always did.
            if not self.keep_all_statuses:
                if status.strip().lower() not in COMPLETED_STATUSES:
                    continue

            customer = _first(field_of, "customer")
            site = _first(field_of, "site name", "site")
            job = _first(field_of, "job num", "job")
            agreement = _first(field_of, "agreement")
            # The live portal heads these columns "Start" and "End"; other
            # listings use a single "Date". Matching only "end date" found
            # neither, so every visit came back with an empty date.
            end = _first(field_of, "end date", "end")
            start = _first(field_of, "start date", "start")
            single = _first(field_of, "date")
            technician = _first(field_of, "lead tech", "technician", "tech")

            href = row.get("href") or ""
            identifier = job.strip() or self._identifier(href, row.get("text", ""))
            if not identifier:
                continue

            visits.append(
                SiteVisit(
                    identifier=identifier.replace(" ", ""),
                    label=f"{customer} / {site}".strip(" /")[:120],
                    customer=customer[:80],
                    site=site[:80],
                    date=(end or start or single).strip(),
                    url=self._absolute(href),
                    row_text=row.get("text", "")[:300],
                    agreement=agreement.strip(),
                    job_number=job.strip(),
                    technician=technician.strip(),
                    start_date=start.strip(),
                    end_date=end.strip(),
                    status=status.strip(),
                )
            )
        return visits

    def _go_to_next_page(self) -> bool:
        """Advance the visit list, if there is another page."""
        try:
            link = self.page.get_by_role("link", name="Next")
            if not link.count():
                return False
            first = link.first
            parent_class = first.evaluate("el => el.parentElement.className || ''")
            if "disabled" in parent_class.lower():
                return False
            before = [r.get("text") for r in self._raw_rows()][:3]
            first.click()
            self.page.wait_for_timeout(1200)
            self.wait_for_content()
            after = [r.get("text") for r in self._raw_rows()][:3]
            # A pager that does not change the rows is the last page.
            return after != before and bool(after)
        except Exception:
            return False

    def _visits_from_links(self) -> list[SiteVisit]:
        try:
            links = self.page.eval_on_selector_all(
                "a[href]",
                "els => els.map(e => ({text: (e.innerText||'').trim(),"
                " href: e.getAttribute('href')}))",
            )
        except Exception:
            return []

        visits = []
        for link in links:
            text = link.get("text") or ""
            href = link.get("href") or ""
            if not text or not self._looks_completed(text):
                continue
            identifier = self._identifier(href, text)
            if not identifier:
                continue
            date_match = DATE_PATTERN.search(text)
            visits.append(
                SiteVisit(
                    identifier=identifier,
                    label=text[:120],
                    date=date_match.group(1) if date_match else "",
                    url=self._absolute(href),
                    row_text=text[:300],
                )
            )
        return self._dedupe(visits)

    @staticmethod
    def _looks_completed(text: str) -> bool:
        lowered = text.lower()
        if any(marker in lowered for marker in INCOMPLETE_MARKERS):
            # "completed" wins over "open" if both appear, since a row may
            # carry an "Open" action button next to a Completed status.
            if not any(m in lowered for m in ("complete", "completed")):
                return False
        if any(marker in lowered for marker in COMPLETED_MARKERS):
            return True
        # A dated row inside a documentation list is a plausible visit even
        # without an explicit status column.
        return bool(DATE_PATTERN.search(text))

    @staticmethod
    def _identifier(href: str, text: str) -> str:
        match = ID_IN_URL.search(href or "")
        if match:
            return match.group(1)
        match = ID_IN_PATH.search(href or "")
        if match:
            return match.group(1)
        # Fall back to a date, which is what the SOP uses to name a visit.
        match = DATE_PATTERN.search(text or "")
        if match:
            return match.group(1).replace("/", "-")
        return ""

    @staticmethod
    def _dedupe(visits: list[SiteVisit]) -> list[SiteVisit]:
        seen: dict[str, SiteVisit] = {}
        for visit in visits:
            seen.setdefault(visit.identifier, visit)
        return list(seen.values())

    def _absolute(self, href: str) -> str:
        if not href:
            return ""
        if href.startswith("http"):
            return href
        return f"{self.base_url}/{href.lstrip('/')}"

    # -- one site visit ---------------------------------------------------
    def open_site_visit(self, visit: SiteVisit) -> None:
        """Enter exactly one completed site visit's context."""
        if visit.url:
            self.page.goto(visit.url, wait_until="domcontentloaded")
        else:
            try:
                find_link(self.page, visit.label or visit.identifier).click()
                self.page.wait_for_load_state("domcontentloaded")
            except PortalError as exc:
                artifacts = self.recorder.capture(self.page, "open-visit-failed")
                self.recorder.note(
                    "open_site_visit", evidence.UNEXPECTED_STRUCTURE, str(exc),
                    url=self.page.url, artifacts=artifacts,
                )
                raise ExplorationError(
                    f"could not open site visit {visit.identifier}: {exc}",
                    evidence.UNEXPECTED_STRUCTURE,
                ) from exc

        self.guard_session("open_site_visit")
        artifacts = self.recorder.capture(self.page, f"visit-{visit.identifier}")

        # Fail closed: the page must still reference the visit we chose.
        if not self._page_mentions(visit):
            self.recorder.note(
                "open_site_visit", evidence.WRONG_CONTEXT,
                f"page does not reference site visit {visit.identifier}",
                url=self.page.url, artifacts=artifacts,
            )
            raise ExplorationError(
                f"opened a page that does not appear to be site visit "
                f"{visit.identifier}; refusing to continue against the wrong "
                "context. See the evidence folder.",
                evidence.WRONG_CONTEXT,
            )

        self.recorder.note(
            "open_site_visit", evidence.AVAILABLE,
            f"site visit {visit.identifier} open",
            url=self.page.url, artifacts=artifacts, visit=visit.to_dict(),
        )

    def _page_mentions(self, visit: SiteVisit) -> bool:
        haystack = f"{self.page.url}\n{self._text()}".lower()
        for token in (visit.identifier, visit.date, visit.customer):
            if token and token.lower() in haystack:
                return True
        return False

    def inventory_actions(self, tag: str = "actions") -> list[str]:
        """Every action the current context offers, recorded as evidence."""
        self.guard_session("inventory_actions")
        actions: list[str] = []
        try:
            actions = self.page.eval_on_selector_all(
                "a, button, input[type=submit], [role=button], [role=tab]",
                "els => els.map(e => ((e.innerText||e.value||'').trim()))"
                ".filter(t => t)",
            )
        except Exception:
            pass
        actions = list(dict.fromkeys(a for a in actions if a))[:150]
        artifacts = self.recorder.capture(self.page, tag)
        self.recorder.note(
            "inventory_actions", evidence.AVAILABLE,
            f"{len(actions)} action(s) offered",
            url=self.page.url, artifacts=artifacts, actions=actions,
        )
        return actions

    def open_document_library(self) -> bool:
        """Open the Document Library within the current site visit."""
        labels = self.settings.get(
            "document_library_labels", ["Document Library", "Documents"]
        )
        for label in labels:
            try:
                find_link(self.page, label).click()
                self.page.wait_for_load_state("domcontentloaded")
            except PortalError:
                try:
                    find_button(self.page, label).click()
                    self.page.wait_for_load_state("domcontentloaded")
                except PortalError:
                    continue
            self.guard_session("open_document_library")
            artifacts = self.recorder.capture(self.page, "document-library")
            self.recorder.note(
                "open_document_library", evidence.AVAILABLE,
                f"opened via {label!r}", url=self.page.url, artifacts=artifacts,
            )
            return True

        artifacts = self.recorder.capture(self.page, "document-library-missing")
        self.recorder.note(
            "open_document_library", evidence.UNAVAILABLE,
            f"none of {labels} were present in this context",
            url=self.page.url, artifacts=artifacts,
        )
        return False

    # -- discovery --------------------------------------------------------
    def discover_documents(self) -> list[DiscoveredDocument]:
        """Map every label in the current context to a canonical report type."""
        from . import canonical

        self.guard_session("discover_documents")
        try:
            candidates = self.page.eval_on_selector_all(
                "a, button, [role=button], li, td",
                "els => els.map(e => ({text: (e.innerText||e.value||'').trim(),"
                " href: e.getAttribute ? (e.getAttribute('href')||'') : ''}))"
                ".filter(x => x.text && x.text.length < 160)",
            )
        except Exception:
            candidates = []

        found: dict[str, DiscoveredDocument] = {}
        for candidate in candidates:
            text = candidate.get("text", "")
            result = canonical.classify(text)
            if result.key is None and not result.ambiguous:
                continue
            document = DiscoveredDocument(
                label=text,
                canonical=result.key,
                href=self._absolute(candidate.get("href", "")),
                ambiguous_between=result.candidates if result.ambiguous else [],
            )
            key = result.key or f"ambiguous:{text}"
            found.setdefault(key, document)

        documents = list(found.values())
        artifacts = self.recorder.capture(self.page, "document-discovery")
        self.recorder.note(
            "discover_documents",
            evidence.AVAILABLE if documents else evidence.UNAVAILABLE,
            f"{len(documents)} candidate document(s) recognised",
            url=self.page.url, artifacts=artifacts,
            documents=[d.to_dict() for d in documents],
        )
        return documents

    # -- downloading ------------------------------------------------------
    def download(self, trigger_text: str, destination: Path, *, step: str = "download") -> Path:
        """Click something and capture whatever file it produces.

        Handles all three ways a portal of this era hands over a file: a real
        download event, a popup that renders the PDF, and a same-tab navigation
        to the document. Whatever arrives is verified to be a real file before
        it is accepted.
        """
        self.guard_session(step)
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        context = self.page.context

        try:
            control = find_link(self.page, trigger_text)
        except PortalError:
            try:
                control = find_button(self.page, trigger_text)
            except PortalError as exc:
                artifacts = self.recorder.capture(self.page, f"{step}-no-control")
                self.recorder.note(
                    step, evidence.UNAVAILABLE,
                    f"no control labelled {trigger_text!r}",
                    url=self.page.url, artifacts=artifacts,
                )
                raise ExplorationError(
                    f"no control labelled {trigger_text!r} in this context",
                    evidence.UNAVAILABLE,
                ) from exc

        known_pages = set(context.pages)
        saved: Path | None = None

        # The common case: the click produces a real download event.
        timeout = int(self.settings.get("download_timeout_ms", 20000))
        try:
            with self.page.expect_download(timeout=timeout) as download_info:
                control.click()
            saved = self._save_download(download_info.value, destination)
        except Exception:
            saved = None

        # Otherwise the portal rendered the document instead of sending it --
        # either into a popup, or into this tab. The click has already
        # happened either way, so any new page is now in the context.
        if saved is None:
            for candidate in context.pages:
                if candidate in known_pages:
                    continue
                saved = self._save_from_page(candidate, destination)
                try:
                    candidate.close()
                except Exception:
                    pass
                if saved is not None:
                    break

        if saved is None:
            saved = self._save_from_page(self.page, destination)

        if saved is None or not saved.exists() or saved.stat().st_size == 0:
            artifacts = self.recorder.capture(self.page, f"{step}-no-file")
            outcome = (
                evidence.classify_page_text(self._text()) or evidence.UNAVAILABLE
            )
            self.recorder.note(
                step, outcome, f"{trigger_text!r} produced no file",
                url=self.page.url, artifacts=artifacts,
            )
            raise ExplorationError(
                f"{trigger_text!r} did not produce a file ({outcome})", outcome
            )

        self.recorder.note(
            step, evidence.AVAILABLE,
            f"{trigger_text!r} -> {saved.name} ({saved.stat().st_size} bytes)",
            url=self.page.url,
        )
        return saved

    def _save_download(self, download, destination: Path) -> Path:
        suggested = download.suggested_filename or destination.name
        target = destination
        if destination.suffix == "" and suggested:
            target = destination.with_name(suggested)
        target = _unique(target)
        download.save_as(str(target))
        return target

    def _save_from_page(self, page, destination: Path) -> Path | None:
        """Pull a document the portal rendered in a tab rather than downloaded."""
        try:
            page.wait_for_load_state("domcontentloaded", timeout=15000)
        except Exception:
            pass
        url = getattr(page, "url", "") or ""
        if not url.startswith("http"):
            return None
        try:
            response = page.context.request.get(url)
            if not response.ok:
                return None
            body = response.body()
        except Exception:
            return None
        if not _looks_like_document(body):
            return None
        target = _unique(destination)
        target.write_bytes(body)
        return target


# What each sign-in failure means for the person running the tool. These are
# the only outcomes that matter, because each needs a different human action.
LOGIN_ADVICE = {
    "invalid_credentials": (
        "the portal rejected the credentials. Check TEGG_USERNAME and "
        "TEGG_PASSWORD, and confirm they work by signing in in a browser."
    ),
    "account_locked": (
        "the account is locked or disabled. This needs the portal "
        "administrator -- repeated attempts will not help."
    ),
    "password_expired": (
        "the password has expired and must be changed in the portal by hand "
        "before automation can sign in."
    ),
    "mfa_required": (
        "the portal is asking for a second factor. This workflow cannot "
        "complete an MFA challenge; a session or an exemption is needed."
    ),
    "captcha_required": (
        "the portal presented a CAPTCHA. Automation cannot solve it -- sign in "
        "manually once, or ask the vendor to exempt this account."
    ),
    "extra_field_required": (
        "the sign-in form wants another value besides username and password."
    ),
    "no_response": (
        "the page neither navigated away nor showed an error. The form may not "
        "have submitted, or the portal may be slow."
    ),
    "rejected": "the portal refused the sign-in.",
}


def _login_failure_message(outcome, responses: list[dict[str, Any]]) -> str:
    """One operator-facing sentence, plus whatever the portal actually said."""
    lines = [
        "login did not complete -- "
        + LOGIN_ADVICE.get(outcome.reason, f"reason: {outcome.reason}")
    ]
    if outcome.detail and outcome.reason != "no_response":
        lines.append(f"\nthe portal said: {outcome.detail}")
    if outcome.extra_fields:
        lines.append(
            "\nfields on the form beyond username and password:\n  "
            + "\n  ".join(outcome.extra_fields)
            + "\n\nIf one of these is required, set it in config/workflow.yaml "
            "under portal.extra_fields."
        )
    if responses:
        chain = ", ".join(f"{r['status']} {r['url']}" for r in responses[-4:])
        lines.append(f"\nsign-in responses: {chain}")
    lines.append(f"\nurl after submitting: {outcome.url}")
    lines.append("evidence (screenshot, redacted HTML) is in the evidence folder.")
    return "\n".join(lines)


def _looks_like_document(body: bytes) -> bool:
    """Reject HTML error pages masquerading as a downloaded report."""
    return body.startswith((PDF_MAGIC, OLE_MAGIC, ZIP_MAGIC))


def _unique(path: Path) -> Path:
    """Never overwrite an existing file; add a numeric suffix instead."""
    path = Path(path)
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for index in range(2, 100):
        candidate = path.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate
    raise ExplorationError(f"cannot find a free filename for {path}")


def verify_file_type(path: Path) -> str:
    """Identify a downloaded file, so a saved HTML error page cannot pass."""
    data = Path(path).read_bytes()[:8]
    if data.startswith(PDF_MAGIC):
        return "pdf"
    if data.startswith(OLE_MAGIC):
        return "doc"
    if data.startswith(ZIP_MAGIC):
        return "docx"
    return "unknown"
