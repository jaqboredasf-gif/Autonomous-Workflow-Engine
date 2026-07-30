"""Deciding which report parameter goes in which dropdown.

The report forms do not label their controls in any way a driver can rely on --
the working live run identified each one purely by the options it contained. So
that discovery is kept here as data and as a pure function over
``(control, options)`` pairs, which means it can be tested exhaustively without
a browser and reviewed without reading Playwright code.

The rules, in the order the live run applied them:

  * a control offering the job's agreement number is the Agreement picker
  * a control offering "Include Images" is the Images picker
  * a control offering both "Locations" and "Tag ID" is the Order By picker

Order matters. The Agreement rule is tried first because setting the agreement
reloads the rest of the form, and because an agreement string is unique enough
that it cannot be confused with anything else.

A control that is marked required and that no rule can satisfy is reported as
an unresolved requirement rather than skipped, because on the real portal an
unset required control makes Print Report silently do nothing -- exactly the
failure that looks like a broken export.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Parameter names, used in results and messages.
AGREEMENT = "Agreement"
IMAGES = "Images"
ORDER_BY = "Order By"
SITE_VISIT = "Site Visit"
RECORD_SELECTION = "Record Selection"

DEFAULT_IMAGES = "Include Images"
DEFAULT_ORDER_BY = "Locations"
DEFAULT_RECORD_SELECTION = "Site Visits"


@dataclass
class Control:
    """One dropdown on a report form, as read off the page."""

    index: int
    options: list[str] = field(default_factory=list)
    required: bool = False
    name: str = ""

    def has(self, *values: str) -> bool:
        return all(v in self.options for v in values)


@dataclass
class Assignment:
    """A decision to set one control to one option."""

    index: int
    parameter: str
    option: str
    reason: str

    def to_dict(self) -> dict:
        return {
            "control_index": self.index,
            "parameter": self.parameter,
            "option": self.option,
            "reason": self.reason,
        }


@dataclass
class Plan:
    """What to set, and what could not be worked out."""

    assignments: list[Assignment] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    missing_fields: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.unresolved and not self.missing_fields

    def to_dict(self) -> dict:
        return {
            "assignments": [a.to_dict() for a in self.assignments],
            "unresolved": list(self.unresolved),
            "missing_fields": list(self.missing_fields),
        }


def plan(
    controls: list[Control],
    *,
    agreement: str,
    order_by: str = DEFAULT_ORDER_BY,
    images: str = DEFAULT_IMAGES,
    site_visit: str = "",
    record_selection: str = DEFAULT_RECORD_SELECTION,
) -> Plan:
    """Work out what to set on a report form.

    ``missing_fields`` names parameters the job needs but the form cannot
    accept -- most importantly an agreement that this report does not offer,
    which means the wrong site or the wrong visit is selected.
    """
    result = Plan()
    claimed: set[int] = set()

    def claim(control: Control, parameter: str, option: str, reason: str) -> None:
        claimed.add(control.index)
        result.assignments.append(
            Assignment(
                index=control.index,
                parameter=parameter,
                option=option,
                reason=reason,
            )
        )

    # 1. Agreement. Unique enough to be unambiguous, and it reloads the form.
    agreement_set = False
    for control in controls:
        if control.index in claimed:
            continue
        if agreement and agreement in control.options:
            claim(
                control,
                AGREEMENT,
                agreement,
                f"offers the job's agreement {agreement!r}",
            )
            agreement_set = True
            break

    # 2. Everything else, by the options that identify it.
    for control in controls:
        if control.index in claimed:
            continue
        if images and images in control.options:
            claim(control, IMAGES, images, f"offers {images!r}")
        elif control.has(DEFAULT_ORDER_BY, "Tag ID"):
            option = order_by if order_by in control.options else DEFAULT_ORDER_BY
            claim(control, ORDER_BY, option, "offers both 'Locations' and 'Tag ID'")
        elif site_visit and site_visit in control.options:
            claim(control, SITE_VISIT, site_visit, f"offers the visit {site_visit!r}")
        elif record_selection and record_selection in control.options:
            claim(
                control,
                RECORD_SELECTION,
                record_selection,
                f"offers {record_selection!r}",
            )

    # 3. Report anything required that nothing claimed.
    for control in controls:
        if control.index in claimed or not control.required:
            continue
        label = control.name or f"control #{control.index}"
        result.unresolved.append(
            f"{label} is required but no rule matched its options "
            f"({', '.join(control.options[:6]) or 'none'})"
        )

    if agreement and not agreement_set:
        offered = sorted({o for c in controls for o in c.options if o})
        result.missing_fields.append(
            f"{AGREEMENT}: no control offers {agreement!r}"
            + (f"; the form offered {', '.join(offered[:8])}" if offered else "")
        )

    return result
