"""TEGG Pro portal automation.

The driver is deliberately *label-driven*. Every control is found by the text
Paul's SOP already names -- "Agreement", "Print Report", "Acrobat PDF file" --
rather than by CSS selectors captured from the DOM. Labels are what the SOP
documents, they survive redesigns that break CSS, and they let the driver be
written and tested before anyone can load the live site.

Each lookup tries several strategies in order and takes the first that resolves
to exactly one control, so a site that labels its fields properly, one that
merely places text beside them, and one that does neither but has recognisable
option values are all handled.

When a lookup does fail, `capture_diagnostics` dumps every label, control and
button on the page, which turns "it didn't work" into a precise list of what to
adjust.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Job, Workflow, portal_credentials

FIRST_AVAILABLE = "__first_available__"


class PortalError(Exception):
    """Raised when the portal cannot be driven as the SOP describes."""


@dataclass
class DownloadResult:
    key: str
    filename: str
    path: Path | None = None
    ok: bool = False
    error: str = ""


@dataclass
class RunReport:
    """Outcome of a full portal run."""

    downloads: list[DownloadResult] = field(default_factory=list)
    diagnostics: list[Path] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.downloads) and all(d.ok for d in self.downloads)

    def summary(self) -> str:
        lines = []
        for item in self.downloads:
            if item.ok:
                lines.append(f"  OK       {item.filename}")
            else:
                lines.append(f"  FAILED   {item.filename}: {item.error}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Locating controls
# ---------------------------------------------------------------------------


def _visible_one(locator):
    """Return a locator if it resolves to at least one visible element."""
    try:
        count = locator.count()
    except Exception:
        return None
    for index in range(min(count, 5)):
        candidate = locator.nth(index)
        try:
            if candidate.is_visible():
                return candidate
        except Exception:
            continue
    return None


def find_field(page, label: str):
    """Find a form control identified by ``label``.

    Strategies, in order: the accessible label, an ARIA combobox name, a
    control following text that contains the label, and finally a select whose
    id or name resembles the label.
    """
    slug = label.lower().replace(" ", "-")
    attempts = [
        lambda: page.get_by_label(label, exact=False),
        lambda: page.get_by_role("combobox", name=label),
        lambda: page.locator(
            f"xpath=//*[contains(normalize-space(text()),{_xpath_literal(label)})]"
            "/following::select[1]"
        ),
        lambda: page.locator(f"select#{slug}, select[name='{slug}']"),
        lambda: page.locator(
            f"select[id*='{slug}' i], select[name*='{slug}' i]"
        ),
    ]
    for attempt in attempts:
        try:
            found = _visible_one(attempt())
        except Exception:
            found = None
        if found is not None:
            return found
    raise PortalError(f"could not find a control labelled {label!r}")


def find_button(page, text: str):
    """Find a button or submit input carrying ``text``."""
    attempts = [
        lambda: page.get_by_role("button", name=text, exact=False),
        lambda: page.locator(f"input[type=submit][value={_css_literal(text)}]"),
        lambda: page.get_by_text(text, exact=False),
        lambda: page.locator(f"a:has-text({_css_literal(text)})"),
    ]
    for attempt in attempts:
        try:
            found = _visible_one(attempt())
        except Exception:
            found = None
        if found is not None:
            return found
    raise PortalError(f"could not find a button labelled {text!r}")


def find_link(page, text: str):
    attempts = [
        lambda: page.get_by_role("link", name=text, exact=False),
        lambda: page.locator(f"a:has-text({_css_literal(text)})"),
        lambda: page.get_by_text(text, exact=False),
    ]
    for attempt in attempts:
        try:
            found = _visible_one(attempt())
        except Exception:
            found = None
        if found is not None:
            return found
    raise PortalError(f"could not find a link labelled {text!r}")


def _xpath_literal(value: str) -> str:
    if "'" not in value:
        return f"'{value}'"
    parts = value.split("'")
    return "concat(" + ", \"'\", ".join(f"'{p}'" for p in parts) + ")"


def _css_literal(value: str) -> str:
    escaped = value.replace('"', '\\"')
    return f'"{escaped}"'


def select_value(page, label: str, value: str) -> str:
    """Set a dropdown, resolving the FIRST_AVAILABLE sentinel.

    Returns the value actually chosen, so the caller can log it.
    """
    control = find_field(page, label)

    if value == FIRST_AVAILABLE:
        options = [
            o for o in control.locator("option").all_text_contents() if o.strip()
        ]
        if not options:
            raise PortalError(f"{label!r} has no selectable options")
        value = options[0].strip()

    try:
        control.select_option(label=value)
        return value
    except Exception:
        pass
    try:
        control.select_option(value=value)
        return value
    except Exception:
        pass

    # Last resort: match an option that merely contains the value.
    options = [o.strip() for o in control.locator("option").all_text_contents()]
    for option in options:
        if value.lower() in option.lower() and option:
            control.select_option(label=option)
            return option

    raise PortalError(
        f"{label!r} has no option matching {value!r}; available: {options}"
    )


def fill_value(page, label: str, value: str) -> None:
    find_field(page, label).fill(value)


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


def capture_diagnostics(page, out_dir: Path, tag: str) -> Path:
    """Dump every control on the current page, plus a screenshot and the HTML.

    This is what turns a failed run against the real site into an actionable
    list rather than a guessing game.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    info: dict[str, Any] = {"url": page.url, "title": page.title()}
    try:
        info["selects"] = page.eval_on_selector_all(
            "select",
            """els => els.map(e => ({
                id: e.id, name: e.name,
                label: (document.querySelector(`label[for="${e.id}"]`)||{}).textContent,
                options: Array.from(e.options).map(o => o.text).slice(0, 25)
            }))""",
        )
        info["inputs"] = page.eval_on_selector_all(
            "input",
            """els => els.map(e => ({
                id: e.id, name: e.name, type: e.type,
                label: (document.querySelector(`label[for="${e.id}"]`)||{}).textContent
            }))""",
        )
        info["buttons"] = page.eval_on_selector_all(
            "button, input[type=submit], a",
            "els => els.map(e => (e.innerText || e.value || '').trim())"
                ".filter(t => t).slice(0, 80)",
        )
    except Exception as exc:
        info["error"] = str(exc)

    path = out_dir / f"diagnostic-{tag}.json"
    path.write_text(json.dumps(info, indent=2), encoding="utf-8")
    try:
        page.screenshot(path=str(out_dir / f"diagnostic-{tag}.png"), full_page=True)
        (out_dir / f"diagnostic-{tag}.html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass
    return path


# ---------------------------------------------------------------------------
# The driver
# ---------------------------------------------------------------------------


class PortalSession:
    """Drives one logged-in portal session."""

    def __init__(self, page, base_url: str, workflow: Workflow, diag_dir: Path) -> None:
        self.page = page
        self.base_url = base_url.rstrip("/")
        self.workflow = workflow
        self.diag_dir = Path(diag_dir)
        self.settings = workflow.raw.get("portal", {})

    # -- login ------------------------------------------------------------
    def login(self, username: str, password: str, contractor: str | None) -> None:
        login_path = self.settings.get("login_path", "/auth/login")
        self.page.goto(f"{self.base_url}{login_path}", wait_until="domcontentloaded")

        labels = self.settings.get("login_labels", {})
        if contractor:
            try:
                select_value(self.page, labels.get("contractor", "Contractor"), contractor)
            except PortalError:
                pass  # not every deployment shows a contractor picker

        fill_value(self.page, labels.get("username", "User Id"), username)
        fill_value(self.page, labels.get("password", "Password"), password)
        find_button(self.page, labels.get("submit", "Log In")).click()
        self.page.wait_for_load_state("domcontentloaded")

        if self._on_login_page():
            capture_diagnostics(self.page, self.diag_dir, "login-failed")
            raise PortalError(
                "login did not complete -- still on the sign-in page. "
                "Check credentials, or see the diagnostic dump."
            )

    def _on_login_page(self) -> bool:
        login_path = self.settings.get("login_path", "/auth/login")
        if login_path in self.page.url:
            return True
        try:
            return self.page.locator("input[type=password]").count() > 0
        except Exception:
            return False

    # -- navigation -------------------------------------------------------
    def navigate(self, trail: list[str]) -> None:
        """Follow a breadcrumb of link texts, e.g. Reports > Standard ESA Reports."""
        for step in trail:
            find_link(self.page, step).click()
            self.page.wait_for_load_state("domcontentloaded")

    # -- documents --------------------------------------------------------
    def download(self, document: dict, job: Job, out_dir: Path) -> DownloadResult:
        key = document["key"]
        filename = document["filename"]
        result = DownloadResult(key=key, filename=filename)

        try:
            self.page.goto(
                f"{self.base_url}{self.settings.get('dashboard_path', '/')}",
                wait_until="domcontentloaded",
            )
            self.navigate(document["nav"])

            params = self.workflow.resolve_params(document, job)
            for label, value in params.items():
                select_value(self.page, _humanize(label), value)

            if document.get("format") == "docx":
                path = self._click_and_download(
                    document.get("action", "Print/Generate Document"), out_dir, filename
                )
            else:
                path = self._print_then_export(out_dir, filename)

            result.path = path
            result.ok = True
        except Exception as exc:
            result.error = str(exc)
            try:
                capture_diagnostics(self.page, self.diag_dir, key)
            except Exception:
                pass
        return result

    def _print_then_export(self, out_dir: Path, filename: str) -> Path:
        export = self.workflow.raw.get("export", {})
        find_button(self.page, export.get("print_button", "Print Report")).click()
        self.page.wait_for_load_state("domcontentloaded")

        select_value(
            self.page,
            export.get("format_label", "Select a Format"),
            export.get("format_value", "Acrobat PDF file"),
        )
        return self._click_and_download(
            export.get("export_button", "Export"), out_dir, filename
        )

    def _click_and_download(self, button_text: str, out_dir: Path, filename: str) -> Path:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        with self.page.expect_download(timeout=120_000) as info:
            find_button(self.page, button_text).click()
        destination = out_dir / filename
        info.value.save_as(str(destination))
        return destination


def _humanize(param_key: str) -> str:
    """Turn a config key like ``site_visit`` into the label ``Site Visit``."""
    return param_key.replace("_", " ").title()


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def preflight() -> list[str]:
    """Everything blocking a live portal run. Empty list means ready."""
    blockers = []
    try:
        import playwright  # noqa: F401
    except ImportError:
        blockers.append("playwright is not installed (pip install 'tegg-esa-report[portal]')")
    try:
        portal_credentials()
    except Exception as exc:
        blockers.append(str(exc))
    return blockers


def plan_downloads(workflow: Workflow, job: Job) -> list[dict[str, Any]]:
    """The click-path and dropdown values for each document, without a browser."""
    return [
        {
            "key": document["key"],
            "filename": document["filename"],
            "format": document.get("format", "pdf"),
            "nav": document["nav"],
            "params": workflow.resolve_params(document, job),
            "action": document.get("action", "Print Report"),
        }
        for document in workflow.documents
    ]


def download_all(
    workflow: Workflow,
    job: Job,
    out_dir: Path,
    *,
    base_url: str | None = None,
    headless: bool = True,
    diag_dir: Path | None = None,
) -> RunReport:
    """Log in and export every document defined in the workflow."""
    blockers = preflight()
    if blockers:
        raise PortalError(
            "portal automation is not ready to run:\n  - " + "\n  - ".join(blockers)
        )

    from playwright.sync_api import sync_playwright

    from .browser import launch

    username, password = portal_credentials()
    contractor = workflow.raw.get("portal", {}).get("contractor")
    url = base_url or workflow.raw["portal"]["base_url"]
    diag_dir = Path(diag_dir or Path(out_dir) / "diagnostics")

    report = RunReport()
    with sync_playwright() as playwright:
        browser = launch(playwright, headless=headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        try:
            session = PortalSession(page, url, workflow, diag_dir)
            session.login(username, password, contractor)
            for document in workflow.documents:
                report.downloads.append(session.download(document, job, out_dir))
        finally:
            context.close()
            browser.close()

    report.diagnostics = sorted(diag_dir.glob("diagnostic-*.json")) if diag_dir.exists() else []
    return report
