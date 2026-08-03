"""The read-only boundary a bounded discovery is allowed to work inside.

Discovery runs against a customer's live portal, so "read-only" cannot be a
convention that a future edit quietly breaks. It is enforced here, by
construction:

  * ``ReadOnlyPage`` wraps a Playwright page and exposes **four** verbs --
    navigate, read text, run a named probe, wait. Every mutating method
    (``click``, ``fill``, ``press``, ``select_option``, ...) raises
    ``MutationRefused`` rather than being merely unused.
  * A probe is not arbitrary JavaScript. It is a name from ``PROBES``, a
    frozen catalogue of expressions that only read. A test asserts every entry
    in the catalogue is free of the tokens that could change a page.
  * Navigation is bounded three ways at once: an allowed set of hosts, a hard
    action count, and a wall-clock deadline. Whichever runs out first stops
    discovery, and running out is an escalation, never a silent truncation.

The wrapper is deliberately not a subclass and does not forward unknown
attributes. Anything not named here is refused, so adding a capability is an
edit somebody has to make on purpose.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


class ReadOnlyViolation(RuntimeError):
    """Base for every refusal this module makes."""


class MutationRefused(ReadOnlyViolation):
    """Something tried to change the page, or submit to the portal."""


class OffDomain(ReadOnlyViolation):
    """Something tried to navigate outside the allowed hosts."""


class BudgetExhausted(ReadOnlyViolation):
    """The action count or the time limit ran out."""


class UnknownProbe(ReadOnlyViolation):
    """A probe was asked for by a name that is not in the catalogue."""


# -- the probe catalogue --------------------------------------------------
# Every entry is a pure read. `js` is evaluated with no arguments and returns
# JSON-serialisable data. Nothing here assigns, clicks, submits or navigates.
PROBES: dict[str, str] = {
    # Every anchor, with the attributes an Angular app routes on.
    "links": """() => Array.from(document.querySelectorAll('a')).slice(0, 400)
        .map(e => ({
            text: (e.innerText || '').trim().slice(0, 80),
            href: e.getAttribute('href') || '',
            router: e.getAttribute('routerLink')
                 || e.getAttribute('ng-reflect-router-link') || '',
            label: e.getAttribute('aria-label') || e.getAttribute('title') || ''
        }))""",
    # Buttons and tabs, which is how a single-page app often names an area.
    "controls": """() => Array.from(
            document.querySelectorAll('button, [role=button], [role=tab], li[routerLink]')
        ).slice(0, 300).map(e => ({
            text: (e.innerText || e.value || '').trim().slice(0, 80),
            router: e.getAttribute('routerLink')
                 || e.getAttribute('ng-reflect-router-link') || ''
        }))""",
    # Table headers, which is the strongest structural marker a list page has.
    "table_headers": """() => Array.from(document.querySelectorAll('table')).slice(0, 20)
        .map(t => Array.from(t.querySelectorAll('th'))
            .map(h => (h.innerText || '').trim().toLowerCase()).slice(0, 30))""",
    # How many data rows the tables hold, so "rendered" can be told from "empty".
    "table_row_counts": """() => Array.from(document.querySelectorAll('table')).slice(0, 20)
        .map(t => t.querySelectorAll('tbody tr').length)""",
    # Filter controls, read only -- the values, never a selection.
    "selects": """() => Array.from(document.querySelectorAll('select')).slice(0, 40)
        .map(e => ({
            id: e.id || '', name: e.name || '',
            options: Array.from(e.options).map(o => (o.text || '').trim()).slice(0, 40)
        }))""",
    # Embedded documents, in case an area lives inside a frame.
    "frames": """() => Array.from(document.querySelectorAll('iframe')).slice(0, 20)
        .map(e => ({src: e.getAttribute('src') || '', name: e.name || ''}))""",
    # Application state a router exposes without touching it.
    "app_state": """() => ({
        path: window.location.pathname,
        hash: window.location.hash,
        title: document.title,
        roots: Array.from(document.querySelectorAll('app-root, [ng-version], router-outlet'))
            .slice(0, 10).map(e => e.tagName.toLowerCase()),
        bodyLength: (document.body ? (document.body.innerText || '').length : 0)
    })""",
}

#: Tokens that would make a probe capable of changing something. Held here so
#: the test that screens the catalogue and the catalogue itself cannot drift.
MUTATING_TOKENS = (
    ".click(", ".submit(", ".focus(", ".blur(",
    "innerHTML =", "innerText =", "textContent =", ".value =",
    "setAttribute", "removeAttribute", "remove()", "appendChild",
    "location =", "location.href", "location.assign", "location.replace",
    "fetch(", "XMLHttpRequest", "localStorage", "sessionStorage",
    "document.cookie", "window.open", "history.pushState", "history.replaceState",
    "dispatchEvent", "requestSubmit",
)

#: Playwright verbs that would act on the portal. Named so the refusal message
#: can say what was attempted rather than "attribute not found".
MUTATING_METHODS = frozenset({
    "click", "dblclick", "fill", "press", "type", "tap", "hover",
    "select_option", "check", "uncheck", "set_input_files", "set_checked",
    "drag_and_drop", "focus", "dispatch_event", "expect_download",
    "request", "route", "on", "add_init_script", "expose_function",
    "evaluate", "evaluate_handle", "eval_on_selector", "eval_on_selector_all",
    "locator", "get_by_role", "get_by_label", "get_by_text", "keyboard", "mouse",
    "go_back", "go_forward", "reload", "set_content",
})


@dataclass
class Budget:
    """How much a bounded step may spend before it must stop and say so."""

    max_actions: int = 12
    max_seconds: float = 90.0
    #: Hosts a navigation may reach. Empty means nothing may be navigated to.
    allowed_hosts: tuple[str, ...] = ()
    spent_actions: int = 0
    started_at: float = field(default_factory=time.monotonic)
    #: Every action taken, in order, for the run's own record.
    trail: list[str] = field(default_factory=list)

    @property
    def elapsed_seconds(self) -> float:
        return time.monotonic() - self.started_at

    @property
    def actions_left(self) -> int:
        return max(0, self.max_actions - self.spent_actions)

    @property
    def seconds_left(self) -> float:
        return max(0.0, self.max_seconds - self.elapsed_seconds)

    def spend(self, what: str) -> None:
        """Charge one action, or refuse. Refusal is the caller's stop signal."""
        if self.spent_actions >= self.max_actions:
            raise BudgetExhausted(
                f"discovery used its {self.max_actions} allowed action(s) "
                f"and stopped before {what}"
            )
        if self.elapsed_seconds >= self.max_seconds:
            raise BudgetExhausted(
                f"discovery ran for {self.elapsed_seconds:.1f}s of its "
                f"{self.max_seconds:.0f}s limit and stopped before {what}"
            )
        self.spent_actions += 1
        self.trail.append(what)

    def check_host(self, url: str) -> None:
        host = (urlparse(url).hostname or "").lower()
        if not host or host not in self.allowed_hosts:
            raise OffDomain(
                f"refusing to navigate to {host or url!r}: discovery may only "
                f"reach {', '.join(self.allowed_hosts) or '(no host allowed)'}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_actions": self.max_actions,
            "max_seconds": self.max_seconds,
            "allowed_hosts": list(self.allowed_hosts),
            "spent_actions": self.spent_actions,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "trail": list(self.trail),
        }


class ReadOnlyPage:
    """A Playwright page with everything that could change the portal removed.

    ``settle`` is the one verb that looks like waiting rather than reading. It
    exists because a single-page app answers "is this area here?" with "not
    yet" for a second or two, and a run that judges too early cannot tell a
    slow route from a dead one -- which is precisely the failure this whole
    slice was built to correct.
    """

    def __init__(self, page: Any, budget: Budget) -> None:
        self._page = page
        self.budget = budget

    # -- refusal ----------------------------------------------------------
    def __getattr__(self, name: str) -> Any:
        if name in MUTATING_METHODS:
            raise MutationRefused(
                f"read-only discovery may not call {name!r} on the portal"
            )
        raise MutationRefused(
            f"{name!r} is not part of the read-only surface; only "
            "goto, url, text, probe, settle, frame_urls and screenshot are"
        )

    # -- navigation -------------------------------------------------------
    @property
    def url(self) -> str:
        return self._page.url

    def goto(self, url: str, *, wait_until: str = "domcontentloaded") -> None:
        self.budget.check_host(url)
        self.budget.spend(f"goto {url}")
        self._page.goto(url, wait_until=wait_until)

    # -- reading ----------------------------------------------------------
    def text(self) -> str:
        try:
            return self._page.inner_text("body")
        except Exception:                                   # noqa: BLE001
            return ""

    def probe(self, name: str) -> Any:
        if name not in PROBES:
            raise UnknownProbe(
                f"no probe named {name!r}; the catalogue is "
                f"{', '.join(sorted(PROBES))}"
            )
        try:
            return self._page.evaluate(PROBES[name])
        except Exception:                                   # noqa: BLE001
            return []

    def frame_urls(self) -> list[str]:
        try:
            return [f.url for f in self._page.frames]
        except Exception:                                   # noqa: BLE001
            return []

    def settle(self, milliseconds: int) -> None:
        """Give the page time without charging an action against the budget.

        Waiting is not a request to the portal, so it is not budgeted as one.
        The wall-clock limit still applies and is what stops an endless wait.
        """
        if self.budget.elapsed_seconds >= self.budget.max_seconds:
            raise BudgetExhausted("discovery ran out of time while waiting")
        try:
            self._page.wait_for_timeout(milliseconds)
        except Exception:                                   # noqa: BLE001
            time.sleep(milliseconds / 1000.0)

    def screenshot(self, path: Path | str) -> str:
        """Capture the page. Best effort -- evidence never fails a run."""
        try:
            self._page.screenshot(path=str(path), full_page=True)
            return str(path)
        except Exception:                                   # noqa: BLE001
            return ""
