"""What proves a page really is the Documentation area.

The failure this slice exists to correct came from a weak answer to that
question. The old navigation record said its expected result was "the site-visit
list is on screen" -- a sentence, not a check -- so the runtime had to fall back
on "is the body non-empty", judged the moment the URL changed. On an Angular
portal that answers "no" for about two seconds after every hard navigation, and
"no" is indistinguishable from a route that has been deleted.

So markers here are three independent structural claims, and a page has to pass
all three:

  * it says the word the area is named after,
  * it offers at least two of the things only that area offers,
  * it carries a table headed the way that area's table is headed.

A signed-in dashboard passes none of them. A blank app shell passes none of
them. A 404 passes none of them. That is the property that makes a *positive*
verdict worth acting on -- and it is why a marker set is stored in the record
rather than compiled into this module: a portal that renames its tabs should be
a knowledge change, not a code change.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

#: The markers the Documentation area is recognised by. Every phrase was read
#: off a live, verified capture of the area, not invented.
DOCUMENTATION_MARKERS: dict[str, Any] = {
    "text_all_of": ["documentation"],
    "text_any_of": [
        "document library",
        "choose timeframe",
        "site visits",
        "site forms",
        "attach images",
    ],
    "text_any_minimum": 2,
    "table_headers_any_of": ["customer", "site name", "status", "agreement"],
    "table_headers_minimum": 2,
}

#: Phrases that mean "this is not the area, and waiting will not help".
DEAD_ROUTE_PHRASES = (
    "not found",
    "404",
    "no such page",
    "page unavailable",
    "nothing here",
    "you are not authorized",
    "not authorised",
    "access denied",
)


@dataclass
class MarkerVerdict:
    """Whether a page matched, and exactly which claims carried the verdict."""

    ok: bool = False
    matched_text: list[str] = field(default_factory=list)
    missing_text: list[str] = field(default_factory=list)
    matched_headers: list[str] = field(default_factory=list)
    table_rows: int = 0
    text_length: int = 0
    url: str = ""
    reason: str = ""
    dead_route_phrase: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def describe(self) -> str:
        if self.ok:
            return (
                f"verified by markers: {', '.join(self.matched_text)} "
                f"+ headers {', '.join(self.matched_headers)} "
                f"({self.table_rows} row(s))"
            )
        return self.reason or "page did not match the Documentation markers"


@dataclass
class Observation:
    """One read of a page, in the only shape the marker check needs.

    Kept as data so a verdict can be reached in a test with no browser, and so
    the same bytes that decided a run can be written into its evidence.
    """

    url: str = ""
    text: str = ""
    table_headers: list[list[str]] = field(default_factory=list)
    table_row_counts: list[int] = field(default_factory=list)
    links: list[dict[str, str]] = field(default_factory=list)
    controls: list[dict[str, str]] = field(default_factory=list)
    selects: list[dict[str, Any]] = field(default_factory=list)
    frames: list[str] = field(default_factory=list)
    app_state: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def rendered(self) -> bool:
        """Has the single-page app put anything on screen yet?"""
        return len(self.text.strip()) > 0


def observe(page: Any) -> Observation:
    """Read everything the marker check and discovery need, in one pass.

    Takes a ``guard.ReadOnlyPage``. Nothing here can act on the portal, because
    nothing on that wrapper can.
    """
    headers = page.probe("table_headers") or []
    return Observation(
        url=page.url,
        text=page.text(),
        table_headers=[[str(h) for h in row] for row in headers],
        table_row_counts=[int(n) for n in (page.probe("table_row_counts") or [])],
        links=[
            {k: str(v) for k, v in link.items()}
            for link in (page.probe("links") or [])
        ],
        controls=[
            {k: str(v) for k, v in control.items()}
            for control in (page.probe("controls") or [])
        ],
        selects=page.probe("selects") or [],
        frames=page.frame_urls(),
        app_state=page.probe("app_state") or {},
    )


def looks_dead(observation: Observation) -> str:
    """The phrase that says this route is gone, or "" if none is present.

    Only meaningful once something has rendered: an empty page says nothing
    about whether the route exists.
    """
    if not observation.rendered:
        return ""
    lowered = observation.text.lower()
    for phrase in DEAD_ROUTE_PHRASES:
        if phrase in lowered:
            return phrase
    return ""


def verify(observation: Observation, markers: dict[str, Any] | None = None) -> MarkerVerdict:
    """Judge one observation against a marker set. All three claims must hold."""
    markers = markers or DOCUMENTATION_MARKERS
    lowered = observation.text.lower()
    verdict = MarkerVerdict(
        url=observation.url,
        text_length=len(observation.text.strip()),
        table_rows=sum(observation.table_row_counts),
    )

    dead = looks_dead(observation)
    if dead:
        verdict.dead_route_phrase = dead
        verdict.reason = f"the page says {dead!r}: this route is not the area"
        return verdict

    if not observation.rendered:
        verdict.reason = "nothing has rendered yet; the page is an empty shell"
        return verdict

    required = [str(t).lower() for t in markers.get("text_all_of", [])]
    missing = [t for t in required if t not in lowered]
    if missing:
        verdict.missing_text = missing
        verdict.reason = (
            "the page never says " + ", ".join(repr(m) for m in missing)
        )
        return verdict
    verdict.matched_text.extend(required)

    optional = [str(t).lower() for t in markers.get("text_any_of", [])]
    minimum = int(markers.get("text_any_minimum", 1))
    hits = [t for t in optional if t in lowered]
    if len(hits) < minimum:
        verdict.matched_text.extend(hits)
        verdict.missing_text = [t for t in optional if t not in lowered]
        verdict.reason = (
            f"only {len(hits)} of the area's own labels are present, "
            f"{minimum} are required"
        )
        return verdict
    verdict.matched_text.extend(hits)

    wanted_headers = [str(h).lower() for h in markers.get("table_headers_any_of", [])]
    header_minimum = int(markers.get("table_headers_minimum", 1))
    if wanted_headers:
        best: list[str] = []
        for row in observation.table_headers:
            found = [h for h in wanted_headers if any(h in cell for cell in row)]
            if len(found) > len(best):
                best = found
        if len(best) < header_minimum:
            verdict.matched_headers = best
            verdict.reason = (
                f"no table on the page is headed like the area's list "
                f"({len(best)} of {header_minimum} required headers matched)"
            )
            return verdict
        verdict.matched_headers = best

    verdict.ok = True
    verdict.reason = "every marker held"
    return verdict


def settle_until_verified(
    page: Any,
    markers: dict[str, Any] | None = None,
    *,
    budget_ms: int = 20000,
    interval_ms: int = 500,
) -> tuple[MarkerVerdict, Observation, int]:
    """Watch a page until its markers hold, it proves dead, or time runs out.

    Returns the verdict, the observation it was reached on, and how long that
    took. The elapsed number is the point: it is the fact the old record was
    missing, and it is what a later run stores so it never has to guess again.
    """
    waited = 0
    observation = observe(page)
    verdict = verify(observation, markers)
    while not verdict.ok and waited < budget_ms:
        if verdict.dead_route_phrase:
            break
        page.settle(interval_ms)
        waited += interval_ms
        observation = observe(page)
        verdict = verify(observation, markers)
    return verdict, observation, waited
