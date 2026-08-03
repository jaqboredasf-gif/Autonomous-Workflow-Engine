"""What an estimate is, as a structure rather than a document.

Workflow-agnostic on purpose. Nothing here knows about TEGG, inspections,
switchgear or PDFs -- an estimate for a roof repair or a software migration has
the same shape. What a particular workflow contributes is a way to turn its own
findings into :class:`ScopeItem` objects; everything after that is shared.

## Money is Decimal, never float

``0.1 + 0.2`` is not ``0.3``, and an estimate that is a cent out is an estimate
somebody stops trusting. Every monetary value here is :class:`decimal.Decimal`,
constructed from strings, and rounded only at the point it is presented.

## Every line carries where it came from

A :class:`LineItem` cannot be built without a :class:`Provenance`, and a line
whose provenance ``may_price`` is false is carried as *unpriced with a reason*
rather than dropped or guessed at. That is the whole reason the evidence module
exists, and it is enforced here rather than by convention.

## The shape

    Estimate
      ├── ScopeItem            what needs doing, and why we think so
      │     └── LineItem       labour / material / equipment / travel / sub
      ├── Adjustment           overhead, contingency, profit, tax -- in order
      ├── Assumption           what we took to be true
      ├── Exclusion            what is deliberately not in the price
      ├── Clarification        what we had to ask rather than guess
      └── Alternate            a priced option the customer may choose

Totals are computed, never stored: a stored total is a total that can disagree
with its lines.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from enum import Enum
from typing import Any, Iterable

from .evidence import Assumption, Clarification, Provenance

ESTIMATE_SCHEMA_VERSION = 1

ZERO = Decimal("0")


def money(value: Any) -> Decimal:
    """A monetary amount. Strings and ints are exact; floats are refused.

    Refusing float is not pedantry. ``Decimal(0.1)`` is
    ``0.1000000000000000055511151231257827``, and the way that reaches an
    estimate is somebody passing a rate straight out of ``json.load``.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        raise TypeError(
            f"refusing to build money from the float {value!r}. Use a string "
            "-- '123.45' -- so the value is exact."
        )
    if value is None or value == "":
        return ZERO
    return Decimal(str(value))


def to_cents(value: Decimal) -> Decimal:
    """Round for presentation. Half-up, because that is what people expect."""
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class LineKind(str, Enum):
    """What sort of cost a line is. Determines which adjustments apply."""

    LABOUR = "labour"
    MATERIAL = "material"
    EQUIPMENT = "equipment"
    TRAVEL = "travel"
    SUBCONTRACTOR = "subcontractor"
    OTHER = "other"


class AdjustmentKind(str, Enum):
    """A change applied to a subtotal, in the order the enum declares."""

    OVERHEAD = "overhead"
    CONTINGENCY = "contingency"
    PROFIT = "profit"
    TAX = "tax"


class Confidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INSUFFICIENT = "insufficient"


class ApprovalStatus(str, Enum):
    DRAFT = "draft"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    BLOCKED = "blocked"


@dataclass
class LineItem:
    """One priced thing. Quantity times unit cost, plus where that came from."""

    kind: LineKind = LineKind.OTHER
    description: str = ""
    quantity: Decimal = ZERO
    unit: str = ""
    unit_cost: Decimal = ZERO
    #: Applied to this line only, e.g. material markup. 0.25 means +25%.
    markup_rate: Decimal = ZERO
    #: Who or what vouches for the *rate*. Rates come from configuration.
    rate_provenance: Provenance = field(default_factory=Provenance)
    #: Who or what vouches for the *quantity or effort*. Often an assumption.
    quantity_provenance: Provenance = field(default_factory=Provenance)
    role: str = ""
    notes: str = ""

    def __post_init__(self) -> None:
        self.quantity = money(self.quantity)
        self.unit_cost = money(self.unit_cost)
        self.markup_rate = money(self.markup_rate)

    @property
    def priceable(self) -> bool:
        """Both the rate and the quantity must rest on something."""
        return self.rate_provenance.may_price and self.quantity_provenance.may_price

    @property
    def blockers(self) -> list[str]:
        out = []
        if not self.rate_provenance.may_price:
            out.append(f"rate: {self.rate_provenance.why_not()}")
        if not self.quantity_provenance.may_price:
            out.append(f"quantity: {self.quantity_provenance.why_not()}")
        return out

    @property
    def base(self) -> Decimal:
        return self.quantity * self.unit_cost

    @property
    def total(self) -> Decimal:
        """Zero when it cannot be priced -- never a guess standing in."""
        if not self.priceable:
            return ZERO
        return self.base * (Decimal("1") + self.markup_rate)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "description": self.description,
            "role": self.role,
            "quantity": str(self.quantity),
            "unit": self.unit,
            "unit_cost": str(to_cents(self.unit_cost)),
            "markup_rate": str(self.markup_rate),
            "base": str(to_cents(self.base)),
            "total": str(to_cents(self.total)),
            "priceable": self.priceable,
            "blockers": self.blockers,
            "rate_provenance": self.rate_provenance.to_dict(),
            "quantity_provenance": self.quantity_provenance.to_dict(),
            "notes": self.notes,
        }


@dataclass
class ScopeItem:
    """One thing that needs doing, with the lines that price it.

    This is the join between a workflow and this package. A workflow produces
    these from whatever it knows -- an inspection finding, a survey, a ticket --
    and everything downstream is shared.
    """

    scope_id: str = ""
    issue: str = ""
    recommended_work: str = ""
    asset_id: str = ""
    asset_type: str = ""
    location: str = ""
    quantity: Decimal = Decimal("1")
    unit: str = "each"
    urgency: str = ""
    access_constraints: list[str] = field(default_factory=list)
    lines: list[LineItem] = field(default_factory=list)
    assumptions: list[Assumption] = field(default_factory=list)
    clarifications: list[Clarification] = field(default_factory=list)
    evidence: list[Provenance] = field(default_factory=list)
    #: Set when this item is deliberately not priced -- already fixed,
    #: undecided scope, customer's own responsibility.
    excluded_reason: str = ""

    def __post_init__(self) -> None:
        self.quantity = money(self.quantity)

    @property
    def priceable(self) -> bool:
        if self.excluded_reason:
            return False
        return bool(self.lines) and all(line.priceable for line in self.lines)

    @property
    def blocked_by(self) -> list[str]:
        if self.excluded_reason:
            return [self.excluded_reason]
        if not self.lines:
            return ["nothing has been costed for this item"]
        reasons = [b for line in self.lines for b in line.blockers]
        reasons += [
            c.question for c in self.clarifications if c.blocks_pricing
        ]
        return reasons

    def subtotal(self, kind: LineKind | None = None) -> Decimal:
        if not self.priceable:
            return ZERO
        return sum(
            (line.total for line in self.lines if kind is None or line.kind is kind),
            ZERO,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "scope_id": self.scope_id,
            "issue": self.issue,
            "recommended_work": self.recommended_work,
            "asset_id": self.asset_id,
            "asset_type": self.asset_type,
            "location": self.location,
            "quantity": str(self.quantity),
            "unit": self.unit,
            "urgency": self.urgency,
            "access_constraints": list(self.access_constraints),
            "lines": [line.to_dict() for line in self.lines],
            "assumptions": [a.to_dict() for a in self.assumptions],
            "clarifications": [c.to_dict() for c in self.clarifications],
            "evidence": [e.to_dict() for e in self.evidence],
            "excluded_reason": self.excluded_reason,
            "priceable": self.priceable,
            "blocked_by": self.blocked_by,
            "subtotal": str(to_cents(self.subtotal())),
        }


@dataclass
class Adjustment:
    """Overhead, contingency, profit or tax, as a rate on a stated base."""

    kind: AdjustmentKind = AdjustmentKind.OVERHEAD
    rate: Decimal = ZERO
    provenance: Provenance = field(default_factory=Provenance)
    #: Which line kinds this applies to. Empty means everything before it --
    #: tax on the whole, overhead on direct cost, and so on.
    applies_to: tuple[LineKind, ...] = ()
    label: str = ""

    def __post_init__(self) -> None:
        self.rate = money(self.rate)

    def amount(self, base: Decimal) -> Decimal:
        return base * self.rate

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "label": self.label or self.kind.value,
            "rate": str(self.rate),
            "applies_to": [k.value for k in self.applies_to],
            "provenance": self.provenance.to_dict(),
        }


@dataclass
class Exclusion:
    """Something deliberately not in the price. Protects both sides."""

    text: str = ""
    provenance: Provenance = field(default_factory=Provenance)

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "provenance": self.provenance.to_dict()}


@dataclass
class Alternate:
    """A priced option the customer may take instead of, or as well as, the base."""

    alternate_id: str = ""
    description: str = ""
    scope: list[ScopeItem] = field(default_factory=list)
    instead_of: str = ""

    def subtotal(self) -> Decimal:
        return sum((item.subtotal() for item in self.scope), ZERO)

    def to_dict(self) -> dict[str, Any]:
        return {
            "alternate_id": self.alternate_id,
            "description": self.description,
            "instead_of": self.instead_of,
            "scope": [s.to_dict() for s in self.scope],
            "subtotal": str(to_cents(self.subtotal())),
        }


@dataclass
class Approval:
    """One decision about one version of an estimate. Append-only in practice."""

    status: ApprovalStatus = ApprovalStatus.DRAFT
    approver: str = ""
    at: str = ""
    rationale: str = ""
    approved_total: str = ""
    changes: list[str] = field(default_factory=list)
    estimate_version: int = 0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        return data


@dataclass
class Estimate:
    """A complete estimate: scope, adjustments, totals, and why to doubt it.

    Totals are properties. A stored total is a total that can disagree with its
    own lines, and the first time that happens is the last time anybody trusts
    the document.
    """

    schema_version: int = ESTIMATE_SCHEMA_VERSION
    estimate_id: str = ""
    version: int = 1
    currency: str = "USD"

    customer: str = ""
    project: str = ""
    site: str = ""
    source_reference: str = ""       # the visit, report or ticket this is for
    prepared_by: str = ""
    prepared_at: str = ""

    scope: list[ScopeItem] = field(default_factory=list)
    adjustments: list[Adjustment] = field(default_factory=list)
    assumptions: list[Assumption] = field(default_factory=list)
    exclusions: list[Exclusion] = field(default_factory=list)
    clarifications: list[Clarification] = field(default_factory=list)
    alternates: list[Alternate] = field(default_factory=list)

    #: Multipliers producing the low and high of the range. 0.85 / 1.30 say the
    #: job could plausibly come in 15% under or 30% over.
    range_low_factor: Decimal = Decimal("1")
    range_high_factor: Decimal = Decimal("1")

    confidence: Confidence = Confidence.INSUFFICIENT
    confidence_reasons: list[str] = field(default_factory=list)

    approval: Approval = field(default_factory=Approval)
    approval_required_because: list[str] = field(default_factory=list)

    pricing_source: str = ""         # which rate card, by name and version
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.range_low_factor = money(self.range_low_factor)
        self.range_high_factor = money(self.range_high_factor)

    # -- what can and cannot be priced ------------------------------------
    @property
    def priced_scope(self) -> list[ScopeItem]:
        return [item for item in self.scope if item.priceable]

    @property
    def unpriced_scope(self) -> list[ScopeItem]:
        return [item for item in self.scope if not item.priceable]

    @property
    def open_questions(self) -> list[Clarification]:
        out = list(self.clarifications)
        for item in self.scope:
            out.extend(item.clarifications)
        return out

    @property
    def unconfirmed_assumptions(self) -> list[Assumption]:
        """Assumptions still resting on nothing that may price."""
        out = [a for a in self.assumptions if not a.provenance.may_price]
        for item in self.scope:
            out.extend(a for a in item.assumptions if not a.provenance.may_price)
        return out

    # -- money ------------------------------------------------------------
    def direct_cost(self, kind: LineKind | None = None) -> Decimal:
        return sum((item.subtotal(kind) for item in self.priced_scope), ZERO)

    @property
    def subtotal(self) -> Decimal:
        return self.direct_cost()

    def applied_adjustments(self) -> list[tuple[Adjustment, Decimal, Decimal]]:
        """Each adjustment with the base it applied to and what it added.

        Applied in the order :class:`AdjustmentKind` declares -- overhead, then
        contingency, then profit, then tax -- each compounding on the running
        total unless it names specific line kinds. The order is a business
        decision and is stated rather than emergent.
        """
        running = self.subtotal
        out: list[tuple[Adjustment, Decimal, Decimal]] = []
        order = list(AdjustmentKind)
        for adjustment in sorted(
            self.adjustments, key=lambda a: order.index(a.kind)
        ):
            base = (
                sum((self.direct_cost(k) for k in adjustment.applies_to), ZERO)
                if adjustment.applies_to
                else running
            )
            amount = adjustment.amount(base)
            out.append((adjustment, base, amount))
            running += amount
        return out

    @property
    def total(self) -> Decimal:
        running = self.subtotal
        for _, _, amount in self.applied_adjustments():
            running += amount
        return running

    @property
    def range(self) -> tuple[Decimal, Decimal, Decimal]:
        base = self.total
        return (base * self.range_low_factor, base, base * self.range_high_factor)

    # -- serialisation ----------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        low, base, high = self.range
        return {
            "schema_version": self.schema_version,
            "estimate_id": self.estimate_id,
            "version": self.version,
            "currency": self.currency,
            "customer": self.customer,
            "project": self.project,
            "site": self.site,
            "source_reference": self.source_reference,
            "prepared_by": self.prepared_by,
            "prepared_at": self.prepared_at,
            "pricing_source": self.pricing_source,
            "scope": [s.to_dict() for s in self.scope],
            "adjustments": [
                {
                    **adjustment.to_dict(),
                    "base": str(to_cents(adj_base)),
                    "amount": str(to_cents(amount)),
                }
                for adjustment, adj_base, amount in self.applied_adjustments()
            ],
            "assumptions": [a.to_dict() for a in self.assumptions],
            "exclusions": [e.to_dict() for e in self.exclusions],
            "clarifications": [c.to_dict() for c in self.open_questions],
            "alternates": [a.to_dict() for a in self.alternates],
            "subtotal": str(to_cents(self.subtotal)),
            "total": str(to_cents(base)),
            "range": {
                "low": str(to_cents(low)),
                "base": str(to_cents(base)),
                "high": str(to_cents(high)),
            },
            "confidence": self.confidence.value,
            "confidence_reasons": list(self.confidence_reasons),
            "approval": self.approval.to_dict(),
            "approval_required_because": list(self.approval_required_because),
            "counts": {
                "scope_items": len(self.scope),
                "priced": len(self.priced_scope),
                "unpriced": len(self.unpriced_scope),
                "open_questions": len(self.open_questions),
                "unconfirmed_assumptions": len(self.unconfirmed_assumptions),
            },
            "warnings": list(self.warnings),
        }


def total_of(items: Iterable[ScopeItem]) -> Decimal:
    return sum((item.subtotal() for item in items), ZERO)
