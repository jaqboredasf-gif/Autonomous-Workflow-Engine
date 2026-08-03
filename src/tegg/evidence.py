"""Structured evidence capture for portal exploration.

The live portal has never been observed by this code. That makes evidence the
product, not a debugging afterthought: every page reached, every action offered
or withheld, and every reason a document could not be produced is written to
disk so the next run can be planned from fact instead of guesswork.

The outcome taxonomy matters more than it looks. "Could not download the EDS
report" is not one condition -- it might be a missing agreement, a permission
limitation, a wrong page, or a portal that simply looks nothing like what we
expected. Those have four different fixes, so they are four different outcomes
and are never collapsed into a generic failure.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Outcome taxonomy.
AVAILABLE = "confirmed_available"
UNAVAILABLE = "unavailable_action"
PERMISSION = "permission_limitation"
MISSING_AGREEMENT = "missing_agreement"
WRONG_CONTEXT = "wrong_page_or_context"
UNEXPECTED_STRUCTURE = "unexpected_portal_structure"
SESSION_EXPIRED = "session_expired"

ALL_OUTCOMES = (
    AVAILABLE,
    UNAVAILABLE,
    PERMISSION,
    MISSING_AGREEMENT,
    WRONG_CONTEXT,
    UNEXPECTED_STRUCTURE,
    SESSION_EXPIRED,
)

# Phrases the portal may use, mapped to what they actually mean. Extended from
# what a live run reports rather than invented wholesale.
PHRASE_OUTCOMES: tuple[tuple[str, str], ...] = (
    ("currently no agreements", MISSING_AGREEMENT),
    ("no agreements", MISSING_AGREEMENT),
    ("no agreement", MISSING_AGREEMENT),
    ("not authorized", PERMISSION),
    ("not authorised", PERMISSION),
    ("access denied", PERMISSION),
    ("permission", PERMISSION),
    ("insufficient rights", PERMISSION),
    ("session has expired", SESSION_EXPIRED),
    ("session expired", SESSION_EXPIRED),
    ("please log in", SESSION_EXPIRED),
    ("sign in to continue", SESSION_EXPIRED),
    ("no data", UNAVAILABLE),
    ("no records", UNAVAILABLE),
    ("no results", UNAVAILABLE),
    ("not available", UNAVAILABLE),
    ("unavailable", UNAVAILABLE),
)


def classify_page_text(text: str) -> str | None:
    """Map visible page text to an outcome, if it says something definite."""
    lowered = (text or "").lower()
    for phrase, outcome in PHRASE_OUTCOMES:
        if phrase in lowered:
            return outcome
    return None


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Observation:
    """One recorded fact about the portal."""

    step: str
    outcome: str
    detail: str = ""
    url: str = ""
    artifacts: list[str] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)
    at: str = field(default_factory=utcnow)

    def to_dict(self) -> dict[str, Any]:
        return {
            "at": self.at,
            "step": self.step,
            "outcome": self.outcome,
            "detail": self.detail,
            "url": self.url,
            "artifacts": list(self.artifacts),
            "data": self.data,
        }

    def line(self) -> str:
        marker = "OK " if self.outcome == AVAILABLE else "!! "
        return f"{marker}{self.step:<34} {self.outcome:<28} {self.detail}"


class Recorder:
    """Collects observations and writes page snapshots beside them."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.observations: list[Observation] = []
        self._counter = 0

    # -- recording --------------------------------------------------------
    def note(
        self,
        step: str,
        outcome: str,
        detail: str = "",
        *,
        url: str = "",
        artifacts: list[str] | None = None,
        **data: Any,
    ) -> Observation:
        observation = Observation(
            step=step,
            outcome=outcome,
            detail=detail,
            url=url,
            artifacts=artifacts or [],
            data=data,
        )
        self.observations.append(observation)
        self.flush()
        return observation

    def capture(self, page, tag: str, *, full_page: bool = True) -> list[str]:
        """Snapshot the current page: screenshot, HTML, and control inventory.

        Failures here are swallowed on purpose -- evidence capture must never
        be the reason a run dies, and a partial snapshot still beats none.
        """
        self._counter += 1
        stem = f"{self._counter:02d}-{_safe(tag)}"
        written: list[str] = []

        try:
            path = self.directory / f"{stem}.png"
            page.screenshot(path=str(path), full_page=full_page)
            written.append(path.name)
        except Exception:
            pass

        try:
            path = self.directory / f"{stem}.html"
            path.write_text(page.content(), encoding="utf-8")
            written.append(path.name)
        except Exception:
            pass

        try:
            path = self.directory / f"{stem}.json"
            path.write_text(
                json.dumps(inventory(page), indent=2), encoding="utf-8"
            )
            written.append(path.name)
        except Exception:
            pass

        return written

    def flush(self) -> Path:
        path = self.directory / "observations.json"
        path.write_text(
            json.dumps([o.to_dict() for o in self.observations], indent=2) + "\n",
            encoding="utf-8",
        )
        return path

    # -- reporting --------------------------------------------------------
    def by_outcome(self, outcome: str) -> list[Observation]:
        return [o for o in self.observations if o.outcome == outcome]

    def summary(self) -> str:
        if not self.observations:
            return "(no observations recorded)"
        return "\n".join(o.line() for o in self.observations)


def inventory(page) -> dict[str, Any]:
    """Everything interactive on the current page, for offline analysis."""
    data: dict[str, Any] = {"url": page.url}
    try:
        data["title"] = page.title()
    except Exception:
        data["title"] = ""

    probes = {
        "links": (
            "a",
            "els => els.map(e => ({text: (e.innerText||'').trim().slice(0,120),"
            " href: e.getAttribute('href')}))"
            ".filter(x => x.text || x.href).slice(0, 250)",
        ),
        "buttons": (
            "button, input[type=submit], input[type=button], [role=button]",
            "els => els.map(e => ((e.innerText||e.value||'').trim()))"
            ".filter(t => t).slice(0, 150)",
        ),
        "selects": (
            "select",
            "els => els.map(e => ({id: e.id, name: e.name,"
            " options: Array.from(e.options).map(o => o.text.trim()).slice(0,60)}))"
            ".slice(0, 60)",
        ),
        "inputs": (
            "input",
            "els => els.map(e => ({id: e.id, name: e.name, type: e.type}))"
            ".slice(0, 120)",
        ),
        "tables": (
            "table",
            "els => els.map(t => ({"
            " headers: Array.from(t.querySelectorAll('th')).map(h => h.innerText.trim()).slice(0,25),"
            " rows: Array.from(t.querySelectorAll('tr')).slice(0,40)"
            "   .map(r => Array.from(r.querySelectorAll('td,th'))"
            "     .map(c => c.innerText.trim()).slice(0,25))"
            "})).slice(0, 12)",
        ),
        "frames": (
            "iframe",
            "els => els.map(e => ({src: e.getAttribute('src'), name: e.name})).slice(0,20)",
        ),
    }
    for key, (selector, script) in probes.items():
        try:
            data[key] = page.eval_on_selector_all(selector, script)
        except Exception as exc:
            data[key] = {"error": str(exc)[:200]}

    try:
        data["visible_text"] = page.inner_text("body")[:8000]
    except Exception:
        data["visible_text"] = ""
    return data


def _safe(value: str) -> str:
    keep = [c if (c.isalnum() or c in "-_") else "-" for c in str(value)]
    return "".join(keep).strip("-")[:60] or "step"
