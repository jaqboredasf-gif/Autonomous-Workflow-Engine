"""The numbers, and the refusal to invent any.

A rate card is the only place money enters an estimate. Nothing in the pricing
engine has a fallback rate, a default hourly figure or a sensible-looking
constant, because the moment one exists it becomes the number that quietly
prices a job nobody checked.

## Two states, and the difference matters

A card is either a **template** (``placeholder: true``) or **production**
(``placeholder: false``). A template is for shaping and testing: it prices, but
every total is stamped as not real and the estimate cannot be approved. Turning
that flag off is a deliberate act by whoever owns the numbers, and it is what
:func:`validate_for_production` checks hardest -- a card claiming to be
production while carrying template values is the one dangerous state, because
everything downstream will believe it.

## Nothing here knows what business this is

Roles are names. Materials are keys. The mapping from *a kind of work on a kind
of asset* to *a role and an effort* is a table in the card, not a function in
this file. A roofing workflow and an electrical workflow use the same loader
and differ only in what their cards say.

The one thing a workflow must do is agree with its card on vocabulary: if the
card has a rule for ``asset_type: "Switchgear"`` then the adapter has to emit
that string. :meth:`RateCard.unmatched_vocabulary` exists so that disagreement
is a reported problem rather than a silently unpriced estimate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

from .model import AdjustmentKind, money

#: What a production card must have before it may price anything.
REQUIRED_SECTIONS = ("labour", "adjustments")

#: Values that mean somebody left the template alone. A production card
#: carrying one of these is refused: it is the state where everything
#: downstream believes a number nobody chose.
TEMPLATE_MARKERS = ("CHANGE ME", "TODO", "REPLACE", "example", "0.00")


class RateCardError(Exception):
    """The rate card cannot be used, and the message says what to fix."""


def _decimal(value: Any, where: str) -> Decimal:
    """Read a number from configuration, refusing the ambiguous ones.

    YAML turns ``0.25`` into a float, which is not exactly 0.25. For a markup
    that is harmless; for a tax rate applied to six figures it is not, and the
    difference is invisible. So the loader accepts what YAML gives it but
    converts through ``str``, which is exact for every literal a person types.
    """
    if value is None or value == "":
        return Decimal("0")
    try:
        return money(str(value))
    except (InvalidOperation, ValueError) as error:
        raise RateCardError(f"{where}: {value!r} is not a number") from error


@dataclass(frozen=True)
class Role:
    """One labour role and what an hour of it costs."""

    name: str
    rate_per_hour: Decimal
    overtime_multiplier: Decimal = Decimal("1.5")
    description: str = ""

    def key(self) -> str:
        return f"labour.roles.{self.name}"


@dataclass(frozen=True)
class Material:
    """One priced material, by the key a workflow refers to it by."""

    key: str
    unit_cost: Decimal
    unit: str = "each"
    description: str = ""

    def config_key(self) -> str:
        return f"materials.items.{self.key}"


@dataclass(frozen=True)
class WorkRule:
    """How a kind of work on a kind of asset turns into effort and materials.

    This is the table that keeps the engine provider-independent. A workflow
    emits ``work_type`` and ``asset_type`` as plain strings; the card says what
    those cost. Neither side needs to know about the other's domain.

    ``hours`` is the expected effort. A rule with no hours is a rule that
    cannot price -- the engine raises a clarification rather than choosing.
    """

    work_type: str
    asset_type: str = ""
    role: str = ""
    hours: Decimal | None = None
    materials: tuple[tuple[str, Decimal], ...] = ()
    material_allowance: Decimal = Decimal("0")
    uncertainty: Decimal | None = None
    notes: str = ""

    @property
    def specificity(self) -> int:
        """How closely this rule was aimed. Higher wins when two match."""
        return (2 if self.asset_type else 0) + (1 if self.work_type else 0)

    def matches(self, work_type: str, asset_type: str) -> bool:
        if self.work_type and self.work_type.lower() != (work_type or "").lower():
            return False
        if self.asset_type and self.asset_type.lower() not in (asset_type or "").lower():
            return False
        return True

    def config_key(self) -> str:
        target = f"{self.work_type}/{self.asset_type}" if self.asset_type else self.work_type
        return f"work.{target}"


@dataclass
class RateCard:
    """Every number an estimate may use, and where each one is written down."""

    source: str = ""
    name: str = ""
    version: str = ""
    currency: str = "USD"
    placeholder: bool = True

    roles: dict[str, Role] = field(default_factory=dict)
    default_role: str = ""
    minimum_hours: Decimal = Decimal("0")
    hour_rounding: Decimal = Decimal("0")
    shutdown_premium_hours: Decimal = Decimal("0")

    normal_hours_per_day: Decimal = Decimal("8")
    overtime_applies: bool = False

    materials: dict[str, Material] = field(default_factory=dict)
    material_markup: Decimal = Decimal("0")

    equipment: dict[str, Decimal] = field(default_factory=dict)
    mobilization_per_visit: Decimal = Decimal("0")
    subcontractor_markup: Decimal = Decimal("0")

    adjustments: dict[AdjustmentKind, Decimal] = field(default_factory=dict)
    adjustment_order: tuple[AdjustmentKind, ...] = tuple(AdjustmentKind)

    range_low_factor: Decimal = Decimal("1")
    range_high_factor: Decimal = Decimal("1")
    total_rounding: Decimal = Decimal("0")

    approval_threshold: Decimal | None = None
    approval_notes: list[str] = field(default_factory=list)

    work_rules: tuple[WorkRule, ...] = ()
    notes: list[str] = field(default_factory=list)

    # -- lookups ----------------------------------------------------------
    def role(self, name: str) -> Role | None:
        return self.roles.get(name) or self.roles.get(name.lower())

    def material(self, key: str) -> Material | None:
        return self.materials.get(key) or self.materials.get(key.lower())

    def rule_for(self, work_type: str, asset_type: str) -> WorkRule | None:
        """The most specific rule that matches, or None. Never a near-miss."""
        matches = [r for r in self.work_rules if r.matches(work_type, asset_type)]
        if not matches:
            return None
        return sorted(matches, key=lambda r: (-r.specificity, r.work_type))[0]

    def unmatched_vocabulary(
        self, pairs: Iterable[tuple[str, str]]
    ) -> list[tuple[str, str]]:
        """Work/asset combinations this card has no rule for.

        The point of failure this catches: an adapter and a card that disagree
        about what a thing is called produce an estimate where everything is
        unpriced for a reason nobody reads. Asking up front turns that into one
        sentence naming the vocabulary gap.
        """
        return [
            (work, asset) for work, asset in pairs
            if self.rule_for(work, asset) is None
        ]

    def describe(self) -> str:
        label = f"{self.name or 'unnamed'} {self.version}".strip()
        state = "TEMPLATE (not real money)" if self.placeholder else "production"
        return f"{label} [{state}] from {self.source}"

    # -- loading ----------------------------------------------------------
    @classmethod
    def load(cls, path: Path | str) -> "RateCard":
        import yaml

        path = Path(path)
        if not path.exists():
            raise RateCardError(
                f"no rate card at {path}. Estimating needs one -- copy the "
                "example card, put your own numbers in it, and point at that."
            )
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as error:
            where = getattr(error, "problem_mark", None)
            place = f" at line {where.line + 1}" if where is not None else ""
            raise RateCardError(
                f"{path} is not valid YAML{place}: {getattr(error, 'problem', error)}"
            ) from error
        if not isinstance(raw, dict):
            raise RateCardError(f"{path}: expected a YAML mapping")
        return cls.from_mapping(dict(raw.get("rate_card") or raw), source=str(path))

    @classmethod
    def from_mapping(cls, data: dict[str, Any], *, source: str = "") -> "RateCard":
        labour = dict(data.get("labour") or {})
        roles: dict[str, Role] = {}
        for name, body in (labour.get("roles") or {}).items():
            body = dict(body or {})
            roles[str(name)] = Role(
                name=str(name),
                rate_per_hour=_decimal(body.get("rate_per_hour"),
                                       f"labour.roles.{name}.rate_per_hour"),
                overtime_multiplier=_decimal(
                    body.get("overtime_multiplier", "1.5"),
                    f"labour.roles.{name}.overtime_multiplier"),
                description=str(body.get("description", "")),
            )

        materials_block = dict(data.get("materials") or {})
        materials: dict[str, Material] = {}
        for key, body in (materials_block.get("items") or {}).items():
            body = dict(body or {})
            materials[str(key)] = Material(
                key=str(key),
                unit_cost=_decimal(body.get("unit_cost"),
                                   f"materials.items.{key}.unit_cost"),
                unit=str(body.get("unit", "each")),
                description=str(body.get("description", "")),
            )

        adjustments: dict[AdjustmentKind, Decimal] = {}
        adjustment_block = dict(data.get("adjustments") or {})
        for kind in AdjustmentKind:
            if kind.value in adjustment_block:
                adjustments[kind] = _decimal(
                    adjustment_block[kind.value], f"adjustments.{kind.value}"
                )
        declared = adjustment_block.get("order")
        order = tuple(AdjustmentKind)
        if declared:
            try:
                order = tuple(AdjustmentKind(str(k)) for k in declared)
            except ValueError as error:
                raise RateCardError(
                    f"adjustments.order names something that is not an "
                    f"adjustment: {error}. Valid: "
                    f"{', '.join(k.value for k in AdjustmentKind)}"
                ) from error

        rules: list[WorkRule] = []
        for entry in data.get("work") or []:
            entry = dict(entry or {})
            pairs = tuple(
                (str(k), _decimal(v, f"work material {k}"))
                for k, v in (entry.get("materials") or {}).items()
            )
            hours = entry.get("hours")
            rules.append(WorkRule(
                work_type=str(entry.get("work_type", "")),
                asset_type=str(entry.get("asset_type", "")),
                role=str(entry.get("role", "")),
                hours=None if hours is None else _decimal(hours, "work hours"),
                materials=pairs,
                material_allowance=_decimal(entry.get("material_allowance"),
                                            "work material_allowance"),
                uncertainty=(None if entry.get("uncertainty") is None
                             else _decimal(entry["uncertainty"], "work uncertainty")),
                notes=str(entry.get("notes", "")),
            ))

        rng = dict(data.get("range") or {})
        approval = dict(data.get("approval") or {})
        equipment_block = dict(data.get("equipment") or {})

        return cls(
            source=source,
            name=str(data.get("name", "")),
            version=str(data.get("version", "")),
            currency=str(data.get("currency", "USD")),
            placeholder=bool(data.get("placeholder", True)),
            roles=roles,
            default_role=str(labour.get("default_role", "")),
            minimum_hours=_decimal(labour.get("minimum_hours"), "labour.minimum_hours"),
            hour_rounding=_decimal(labour.get("hour_rounding"), "labour.hour_rounding"),
            shutdown_premium_hours=_decimal(
                labour.get("shutdown_premium_hours"), "labour.shutdown_premium_hours"),
            normal_hours_per_day=_decimal(
                labour.get("normal_hours_per_day", "8"), "labour.normal_hours_per_day"),
            overtime_applies=bool(labour.get("overtime_applies", False)),
            materials=materials,
            material_markup=_decimal(materials_block.get("markup"), "materials.markup"),
            equipment={
                str(k): _decimal(v, f"equipment.{k}")
                for k, v in (equipment_block.get("items") or {}).items()
            },
            mobilization_per_visit=_decimal(
                (data.get("mobilization") or {}).get("per_visit"),
                "mobilization.per_visit"),
            subcontractor_markup=_decimal(
                (data.get("subcontractor") or {}).get("markup"),
                "subcontractor.markup"),
            adjustments=adjustments,
            adjustment_order=order,
            range_low_factor=_decimal(rng.get("low_factor", "1"), "range.low_factor"),
            range_high_factor=_decimal(rng.get("high_factor", "1"), "range.high_factor"),
            total_rounding=_decimal(data.get("total_rounding"), "total_rounding"),
            approval_threshold=(
                None if approval.get("threshold_total") is None
                else _decimal(approval["threshold_total"], "approval.threshold_total")),
            approval_notes=[str(n) for n in (approval.get("notes") or [])],
            work_rules=tuple(rules),
            notes=[str(n) for n in (data.get("notes") or [])],
        )


# -- validation -----------------------------------------------------------


def validate(card: RateCard) -> list[str]:
    """Everything structurally wrong with a card, template or production."""
    problems: list[str] = []

    if not card.roles:
        problems.append("labour.roles is empty -- no work can be priced")
    for name, role in card.roles.items():
        if role.rate_per_hour <= 0:
            problems.append(f"labour.roles.{name}.rate_per_hour must be above zero")
        if role.overtime_multiplier < 1:
            problems.append(
                f"labour.roles.{name}.overtime_multiplier is below 1, which "
                "would make overtime cheaper than normal time"
            )
    if card.default_role and not card.role(card.default_role):
        problems.append(
            f"labour.default_role is {card.default_role!r}, which is not in "
            f"labour.roles ({', '.join(sorted(card.roles)) or 'none'})"
        )

    for key, material in card.materials.items():
        if material.unit_cost < 0:
            problems.append(f"materials.items.{key}.unit_cost is negative")

    for kind, rate in card.adjustments.items():
        if rate < 0:
            problems.append(f"adjustments.{kind.value} is negative")
        if rate > 1:
            problems.append(
                f"adjustments.{kind.value} is {rate}, i.e. {rate * 100:.0f}%. "
                "Rates are fractions -- 0.12 for 12%."
            )

    if card.range_low_factor > 1:
        problems.append("range.low_factor is above 1, so the low is above the base")
    if card.range_high_factor < 1:
        problems.append("range.high_factor is below 1, so the high is below the base")

    for index, rule in enumerate(card.work_rules):
        if not rule.work_type:
            problems.append(f"work[{index}] has no work_type")
        if rule.role and not card.role(rule.role):
            problems.append(
                f"work[{index}] ({rule.config_key()}) names role {rule.role!r}, "
                "which is not in labour.roles"
            )
        if rule.hours is not None and rule.hours <= 0:
            problems.append(f"work[{index}] ({rule.config_key()}) has hours <= 0")

    return problems


def validate_for_production(card: RateCard) -> list[str]:
    """Everything that must be true before this card may price real money.

    Stricter than :func:`validate` on purpose. The dangerous state is not a
    template -- a template announces itself -- it is a card that *claims* to be
    production while still carrying the shape somebody was handed.
    """
    problems = validate(card)

    if card.placeholder:
        problems.append(
            "this card is marked 'placeholder: true', so it is a template. Its "
            "numbers are illustrative. Set 'placeholder: false' only when the "
            "figures in it are your own."
        )
        return problems

    if not card.name or not card.version:
        problems.append(
            "a production card must carry a name and a version, so an estimate "
            "can say which prices it was built from"
        )
    for section in REQUIRED_SECTIONS:
        if section == "labour" and not card.roles:
            problems.append("a production card must define at least one labour role")
        if section == "adjustments" and not card.adjustments:
            problems.append(
                "a production card must state its adjustments -- overhead, "
                "contingency, profit and tax. Zero is a valid answer; absent is not."
            )

    for kind in (AdjustmentKind.OVERHEAD, AdjustmentKind.PROFIT):
        if kind not in card.adjustments:
            problems.append(
                f"adjustments.{kind.value} is not set. If it genuinely does not "
                "apply, write 0 so the decision is recorded."
            )

    haystack = " ".join([card.name, card.version, *card.notes]).lower()
    for marker in TEMPLATE_MARKERS:
        if marker.lower() in haystack and marker != "0.00":
            problems.append(
                f"this card still says {marker!r}, which suggests it was not "
                "filled in. A production card should not read like a template."
            )
            break

    if not card.work_rules:
        problems.append(
            "no work rules. Without them nothing maps to an effort, and every "
            "scope item comes back needing a person"
        )

    if card.approval_threshold is None:
        problems.append(
            "approval.threshold_total is not set. It decides which estimates a "
            "person must sign off; leaving it unset would let any amount pass."
        )

    return problems


def require_production(card: RateCard) -> RateCard:
    """Return the card, or raise with everything wrong with it at once."""
    problems = validate_for_production(card)
    if problems:
        listed = "\n  - ".join(problems)
        raise RateCardError(
            f"{card.source or 'this rate card'} cannot be used to price real "
            f"work:\n  - {listed}"
        )
    return card
