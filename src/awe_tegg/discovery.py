"""Finding the Documentation area again, without guessing and without acting.

Discovery runs only after stored knowledge has been tried and has contradicted
the live portal. It has one job: work out, from what the portal is showing
right now, which route currently serves the area -- and prove it with markers
rather than with a name that looks right.

Three rules make it safe to point at a customer's production portal:

  * **Only live candidates.** A candidate route has to appear in the page the
    run is looking at -- a link, a router target, a tab. Nothing is tried
    because a record remembers it, which is also what stops the contradicted
    route from being retried on the strength of the belief that just failed.
    If that route is still in the portal's own navigation it comes back as a
    live candidate, on equal footing with every other, and is tried once.
  * **Read-only by construction.** Everything goes through
    ``guard.ReadOnlyPage``: navigate, read, wait. There is no code path from
    here to a click, a keystroke or a submission.
  * **Bounded, and honest when the bound is hit.** Actions and wall-clock are
    both capped. Running out returns "no safe route found", never a best guess,
    and the caller escalates to a person.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

from . import markers as marker_module
from .guard import Budget, BudgetExhausted, OffDomain, ReadOnlyPage

#: Words that make a link worth trying when looking for a documentation area.
#: Ordered: an earlier word is a stronger signal than a later one.
AREA_KEYWORDS: tuple[str, ...] = ("documentation", "document", "site visit")

#: Routes that are never worth a navigation, whatever they are labelled.
NEVER_FOLLOW = (
    "logout", "log-out", "signout", "sign-out", "/auth/login",
    "javascript:", "mailto:", "tel:", "#",
)


@dataclass
class Candidate:
    """One route discovery thought was worth a look, and what came of it."""

    url: str
    source: str = ""            # link | control | frame
    label: str = ""
    score: int = 0
    tried: bool = False
    verified: bool = False
    settle_ms: int = 0
    verdict: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DiscoveryResult:
    """What a bounded discovery established, or why it could not."""

    ok: bool = False
    url: str = ""
    route: str = ""
    settle_ms: int = 0
    markers: dict[str, Any] = field(default_factory=dict)
    verdict: dict[str, Any] = field(default_factory=dict)
    observation: dict[str, Any] = field(default_factory=dict)
    candidates: list[dict[str, Any]] = field(default_factory=list)
    budget: dict[str, Any] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    reason: str = ""
    #: What a person has to do, when discovery could not finish the job alone.
    escalation: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _absolute(base_url: str, href: str) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href
    return urljoin(base_url.rstrip("/") + "/", href.lstrip("/"))


def _normalise(url: str) -> str:
    """Compare routes by path, ignoring a trailing slash and any query."""
    parsed = urlparse(url)
    path = (parsed.path or "/").rstrip("/") or "/"
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def _score(text: str, href: str, router: str, label: str) -> int:
    """How strongly one candidate looks like the area we are hunting for.

    Visible text beats an accessible label beats a URL, because a URL that
    merely contains the word is the weakest evidence of the three -- and a
    single-page app that renders its navigation as icons has no visible text
    at all, which is exactly the case that broke the fallback before.
    """
    haystacks = (
        (text or "").lower(),
        (label or "").lower(),
        f"{href or ''} {router or ''}".lower(),
    )
    weights = (6, 4, 2)
    best = 0
    for index, keyword in enumerate(AREA_KEYWORDS):
        bonus = len(AREA_KEYWORDS) - index          # earlier keyword, stronger
        for haystack, weight in zip(haystacks, weights):
            if keyword in haystack:
                best = max(best, weight + bonus)
    return best


def candidates_from(
    observation: marker_module.Observation, base_url: str
) -> list[Candidate]:
    """Every route the page in front of us offers that could be the area.

    Deduplicated by normalised URL, strongest first, then by URL so two runs
    reading the same page try the same routes in the same order.
    """
    found: dict[str, Candidate] = {}

    def consider(url: str, source: str, label: str, score: int) -> None:
        if score <= 0 or not url:
            return
        lowered = url.lower()
        if any(bad in lowered for bad in NEVER_FOLLOW):
            return
        key = _normalise(url)
        existing = found.get(key)
        if existing is None or score > existing.score:
            found[key] = Candidate(url=url, source=source, label=label, score=score)

    for link in observation.links:
        target = link.get("href") or link.get("router") or ""
        consider(
            _absolute(base_url, target),
            "link",
            (link.get("text") or link.get("label") or "").strip()[:60],
            _score(link.get("text", ""), link.get("href", ""),
                   link.get("router", ""), link.get("label", "")),
        )
    for control in observation.controls:
        target = control.get("router") or ""
        consider(
            _absolute(base_url, target),
            "control",
            (control.get("text") or "").strip()[:60],
            _score(control.get("text", ""), "", control.get("router", ""), ""),
        )
    for src in observation.frames:
        consider(
            _absolute(base_url, src), "frame", "iframe",
            _score("", src, "", ""),
        )

    return sorted(found.values(), key=lambda c: (-c.score, c.url))


def discover_documentation(
    page: ReadOnlyPage,
    *,
    base_url: str,
    markers: dict[str, Any] | None = None,
    settle_budget_ms: int = 20000,
    evidence_dir: Path | None = None,
    max_candidates: int = 4,
) -> DiscoveryResult:
    """Find the current Documentation route from the page we are on.

    The caller is expected to be signed in and sitting on a page that carries
    the portal's own navigation -- the dashboard. Everything tried comes from
    what that page offers.
    """
    markers = markers or marker_module.DOCUMENTATION_MARKERS
    result = DiscoveryResult(markers=dict(markers))

    # The launch pad has to have rendered before its navigation can be read.
    # This is the same lesson the whole repair is about, applied to discovery
    # itself: an empty app shell offers no links, and reading one too early is
    # how a live route gets mistaken for a dead one.
    start = marker_module.observe(page)
    waited = 0
    while not start.rendered and waited < settle_budget_ms:
        page.settle(500)
        waited += 500
        start = marker_module.observe(page)

    if not start.rendered:
        result.reason = (
            "the page discovery started from never rendered, so it offered no "
            "navigation to work from"
        )
        result.escalation = (
            "sign in by hand and confirm the portal still loads; if it does, "
            "the run's start page is wrong"
        )
        result.budget = page.budget.to_dict()
        return result

    found = candidates_from(start, base_url)
    if not found:
        result.reason = (
            "the portal's own navigation offered no route mentioning "
            + " / ".join(AREA_KEYWORDS)
        )
        result.escalation = (
            "open the portal by hand and note where Documentation now lives, "
            "then set portal.documentation_path in config/workflow.yaml"
        )
        result.candidates = []
        result.budget = page.budget.to_dict()
        return result

    for candidate in found[:max_candidates]:
        try:
            page.goto(candidate.url)
        except BudgetExhausted as exhausted:
            result.reason = str(exhausted)
            result.escalation = (
                "discovery hit its safety limit before it could prove a route. "
                "Re-run with a larger --discovery-budget, or find the route by hand."
            )
            break
        except OffDomain as off:
            candidate.verdict = {"reason": str(off)}
            continue

        candidate.tried = True
        verdict, observation, settle_ms = marker_module.settle_until_verified(
            page, markers, budget_ms=settle_budget_ms
        )
        candidate.settle_ms = settle_ms
        candidate.verified = verdict.ok
        candidate.verdict = verdict.to_dict()

        if verdict.ok:
            result.ok = True
            result.url = page.url
            result.route = urlparse(page.url).path or "/"
            result.settle_ms = settle_ms
            result.verdict = verdict.to_dict()
            result.observation = observation.to_dict()
            if evidence_dir is not None:
                shot = page.screenshot(
                    Path(evidence_dir) / "discovery-documentation-verified.png"
                )
                if shot:
                    result.evidence.append(Path(shot).name)
            result.reason = (
                f"{result.route} showed every Documentation marker "
                f"{settle_ms} ms after loading"
            )
            break

    result.candidates = [c.to_dict() for c in found[:max_candidates]]
    result.budget = page.budget.to_dict()
    if not result.ok and not result.reason:
        result.reason = (
            f"none of the {len(result.candidates)} route(s) the portal offered "
            "showed the Documentation markers"
        )
    if not result.ok and not result.escalation:
        result.escalation = (
            "no route proved to be the Documentation area. Open the portal by "
            "hand, find where it moved to, and record it before running again. "
            "Nothing was changed in the portal."
        )
    return result
