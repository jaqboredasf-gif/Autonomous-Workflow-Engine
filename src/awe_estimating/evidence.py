"""Where every number in an estimate came from.

An estimate is a claim about money that somebody will be held to. The claim is
only as good as its weakest line, and the thing that makes a line weak is not
being wrong -- it is being *unattributable*. A figure nobody can trace is one
nobody can check, defend, or correct.

So no value enters an estimate without saying which of five kinds of thing it
came from:

    REPORT          an inspection document says so, at a page you can open
    TECHNICIAN      a qualified person recommended it, in their own words
    CONFIGURATION   an approved rate card says so, at a named key
    HISTORICAL      a comparable completed job says so
    HUMAN           somebody decided it, and put their name to it

and one that is not evidence at all and is tracked separately:

    AI_PROPOSAL     a model suggested it

## Why AI proposals are a different kind

A model's suggestion is a hypothesis. It may be a good one -- proposing that a
switchgear fuse replacement is four hours is exactly the sort of thing a model
can do usefully -- but it is not evidence, and the difference has to survive
all the way to the person approving the estimate.

So an ``AI_PROPOSAL`` cannot price anything on its own. It must be *confirmed*
into one of the real classes first: matched against configuration, matched
against a historical job, or accepted by a named human. Until then it is
carried as an open question, visible in the output.

:meth:`Provenance.may_price` is where that rule lives, and it is the reason
this module exists rather than a string field called ``source``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class EvidenceClass(str, Enum):
    """What kind of thing vouches for a value."""

    REPORT = "report"
    TECHNICIAN = "technician"
    CONFIGURATION = "configuration"
    HISTORICAL = "historical"
    HUMAN = "human"
    AI_PROPOSAL = "ai_proposal"

    @property
    def is_evidence(self) -> bool:
        """Whether this class can stand behind a number on its own."""
        return self is not EvidenceClass.AI_PROPOSAL

    def describe(self) -> str:
        return {
            EvidenceClass.REPORT: "an inspection document",
            EvidenceClass.TECHNICIAN: "the technician's own recommendation",
            EvidenceClass.CONFIGURATION: "the approved rate card",
            EvidenceClass.HISTORICAL: "a comparable completed job",
            EvidenceClass.HUMAN: "a person's stated assumption",
            EvidenceClass.AI_PROPOSAL: "a model's suggestion, not yet confirmed",
        }[self]


@dataclass(frozen=True)
class Provenance:
    """One value's origin, in a form somebody can go and check.

    ``locator`` is deliberately free text because what identifies a source
    differs by class: a page for a report, a key path for configuration, a job
    id for a historical comparable, a person's name for a human assumption.
    What matters is that it is *specific enough to find again*.
    """

    kind: EvidenceClass = EvidenceClass.HUMAN
    locator: str = ""
    detail: str = ""
    #: Set when an AI proposal was confirmed, naming what confirmed it. An
    #: AI_PROPOSAL with this set has been promoted and may price.
    confirmed_by: str = ""

    @property
    def may_price(self) -> bool:
        """Whether a money figure may rest on this.

        The single rule this module exists to enforce: a model's suggestion
        does not become money until something else vouches for it.
        """
        if self.kind.is_evidence:
            return bool(self.locator)
        return bool(self.confirmed_by)

    def why_not(self) -> str:
        """Why this cannot price, in words. Empty when it can."""
        if self.may_price:
            return ""
        if not self.kind.is_evidence:
            return (
                "this figure was proposed by a model and nothing has confirmed "
                "it -- it needs a rate-card entry, a comparable job, or a "
                "person's sign-off before it can be priced"
            )
        return f"{self.kind.value} evidence with no locator cannot be checked"

    def cite(self) -> str:
        base = f"{self.kind.describe()}"
        if self.locator:
            base += f" ({self.locator})"
        if self.confirmed_by:
            base += f", confirmed by {self.confirmed_by}"
        return base

    def confirm(self, by: str, *, locator: str = "") -> "Provenance":
        """Promote a proposal into something that may price."""
        return Provenance(
            kind=self.kind,
            locator=locator or self.locator,
            detail=self.detail,
            confirmed_by=by,
        )

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["kind"] = self.kind.value
        data["may_price"] = self.may_price
        data["cite"] = self.cite()
        return data


# -- the constructors callers should actually use -------------------------


def from_report(locator: str, detail: str = "") -> Provenance:
    """A page of a document somebody can open."""
    return Provenance(EvidenceClass.REPORT, locator, detail)


def from_technician(locator: str, detail: str = "") -> Provenance:
    """Words a qualified person wrote, quoted rather than paraphrased."""
    return Provenance(EvidenceClass.TECHNICIAN, locator, detail)


def from_config(key: str, detail: str = "") -> Provenance:
    """A named key in approved configuration. The only source of rates."""
    return Provenance(EvidenceClass.CONFIGURATION, key, detail)


def from_history(job: str, detail: str = "") -> Provenance:
    """A completed job this was compared against."""
    return Provenance(EvidenceClass.HISTORICAL, job, detail)


def from_human(who: str, detail: str = "") -> Provenance:
    """Somebody's stated assumption, with their name on it."""
    return Provenance(EvidenceClass.HUMAN, who, detail)


def proposed_by_ai(model: str, detail: str = "") -> Provenance:
    """A suggestion. Cannot price until confirmed -- see :meth:`may_price`."""
    return Provenance(EvidenceClass.AI_PROPOSAL, model, detail)


@dataclass
class Assumption:
    """Something taken to be true that the evidence does not settle.

    Every estimate rests on these. The failure mode is not making them -- it is
    making them silently, so nobody can disagree. Each one carries who or what
    is behind it and whether it changes the money.
    """

    text: str = ""
    provenance: Provenance = field(default_factory=Provenance)
    #: True when the estimate would change if this assumption were wrong.
    material: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "provenance": self.provenance.to_dict(),
            "material": self.material,
            "needs_confirmation": not self.provenance.may_price,
        }


@dataclass
class Clarification:
    """A question that must be answered before this can be priced properly.

    Emitted instead of guessing. A scope item with an open clarification is
    still estimated where it can be, and the gap is stated rather than filled
    with a plausible number.
    """

    question: str = ""
    why_it_matters: str = ""
    blocks_pricing: bool = False
    about: str = ""
    provenance: Provenance = field(default_factory=Provenance)

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "why_it_matters": self.why_it_matters,
            "blocks_pricing": self.blocks_pricing,
            "about": self.about,
            "provenance": self.provenance.to_dict(),
        }
