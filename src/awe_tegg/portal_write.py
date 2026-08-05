"""Creating or updating a report record in TEGG. Off unless deliberately armed.

Everything else in this package is read-only against the portal, by
construction and on purpose: ``guard.ReadOnlyPage`` has no ``click``, and
``documents.ReportRun`` screens every control it touches against
:data:`documents.FORBIDDEN_WORDS`, which includes *save*, *submit* and
*complete*. That contract is documented in the README, asserted in
``tests/awe_tegg/test_operator_safety.py``, and it is the reason this tool has
been safe to point at a production tenant.

This module is the one authorised exception, and it is built so the exception
cannot leak:

  * **Two locks, not one.** The capability must be enabled (``--create-tegg-
    report``) *and* the operator must type a confirmation phrase at run time.
    Neither alone arms it. There is no environment variable that arms it,
    because an environment variable set once stays set.
  * **It never guesses a control.** The label of the control that saves a
    report is read from ``config/service.yaml`` under ``service.write:``. If
    the configured label is not on the page, the run escalates to a person --
    it does not look for something similar. A tool that goes hunting for a
    button labelled something like "save" on a production portal is exactly
    the accident this codebase was built to prevent.
  * **It records what it did.** Every action lands in the ledger under
    *external changes performed*, which is printed at the end of every run.
  * **It is off in the shipped package.** Nothing in the Windows launchers
    passes the flag.

The selectors here have NOT been proven against the live portal -- there was no
authorised live write to prove them with. Until somebody runs this headed,
against a visit they are willing to change, with a person watching, treat the
configured labels as a hypothesis. It fails closed: an unproven label produces
an escalation, not a wrong click.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

#: What the operator must type, exactly, before a write is attempted. Long and
#: specific: "y" is what somebody types to make a prompt go away.
CONFIRMATION_PHRASE = "CREATE THE REPORT IN TEGG"


class WriteRefused(Exception):
    """A write was asked for and not permitted. Nothing was changed."""


class WriteNotConfigured(Exception):
    """The capability is armed but nobody has said which control saves."""


@dataclass
class WritePolicy:
    """Whether this run may write to TEGG, and what it may click if so.

    Both ``enabled`` and ``confirmed`` must be true. They are set from
    different places on purpose -- one from the command line, one from a human
    at the keyboard -- so no single mistake arms the capability.
    """

    enabled: bool = False
    confirmed: bool = False
    #: The exact control labels, from config. No defaults: an unconfigured
    #: write is an escalation, never a guess.
    create_labels: tuple[str, ...] = ()
    update_labels: tuple[str, ...] = ()
    confirm_labels: tuple[str, ...] = ()
    #: Recorded for the run output.
    actions: list[str] = field(default_factory=list)

    @property
    def armed(self) -> bool:
        return bool(self.enabled and self.confirmed)

    @classmethod
    def from_settings(cls, mapping: dict[str, Any] | None, *, enabled: bool) -> "WritePolicy":
        mapping = mapping or {}
        return cls(
            enabled=bool(enabled),
            create_labels=tuple(mapping.get("create_labels") or ()),
            update_labels=tuple(mapping.get("update_labels") or ()),
            confirm_labels=tuple(mapping.get("confirm_labels") or ()),
        )

    def describe(self) -> str:
        if not self.enabled:
            return ("read-only: no report record will be created or updated in "
                    "TEGG (this is the default and the shipped behaviour)")
        if not self.confirmed:
            return "write requested but not confirmed at the keyboard; refused"
        return (
            "ARMED: this run may create or update a report record in TEGG using "
            f"the configured control(s) {list(self.create_labels or self.update_labels)}"
        )


def confirm(
    policy: WritePolicy,
    ask: Callable[[str], str],
    say: Callable[[str], None],
    *,
    customer: str = "",
    site: str = "",
    site_visit: str = "",
) -> WritePolicy:
    """Ask the operator to arm the write, in words that state the consequence.

    Anything other than the exact phrase leaves the run read-only and says so.
    It does not stop the run: producing the documents read-only is still
    the useful outcome, and losing that because somebody mistyped would be a
    worse failure than not writing.
    """
    if not policy.enabled:
        return policy
    say("")
    say("!" * 68)
    say("  THIS RUN HAS BEEN ASKED TO WRITE TO TEGG")
    say("!" * 68)
    say("")
    say("  Everything else this tool does only reads. If you continue, it will")
    say("  create or update a REAL report record in the live TEGG portal for:")
    say("")
    say(f"      customer    {customer or '(not given)'}")
    say(f"      site        {site or '(not given)'}")
    say(f"      site visit  {site_visit or '(not given)'}")
    say("")
    say("  This changes a customer record. It may not be undoable from here.")
    say("")
    say(f"  To go ahead, type exactly:   {CONFIRMATION_PHRASE}")
    say("  Anything else keeps this run read-only, which is safe.")
    try:
        typed = (ask("  > ") or "").strip()
    except (KeyboardInterrupt, EOFError):
        typed = ""
    policy.confirmed = typed == CONFIRMATION_PHRASE
    say("")
    say("  Confirmed: this run will write to TEGG." if policy.confirmed
        else "  Not confirmed. This run stays read-only; documents are still produced.")
    return policy


def _find(page: Any, labels: tuple[str, ...]) -> tuple[Any, str]:
    """The one configured control, or nothing. Never something similar."""
    for label in labels:
        try:
            locator = page.get_by_text(label, exact=True)
            for index in range(min(locator.count(), 8)):
                candidate = locator.nth(index)
                if candidate.is_visible():
                    return candidate, label
        except Exception:                                   # noqa: BLE001
            continue
    return None, ""


def create_or_update(
    page: Any,
    policy: WritePolicy,
    *,
    on_note: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Create or update the report record. Refuses unless fully armed.

    Returns what it did, for the ledger. Raises rather than improvising.
    """
    note = on_note or (lambda message: None)

    if not policy.enabled:
        raise WriteRefused(
            "a TEGG write was attempted but the capability is not enabled. "
            "Nothing was changed."
        )
    if not policy.confirmed:
        raise WriteRefused(
            "a TEGG write was attempted but the operator did not confirm it at "
            "the keyboard. Nothing was changed."
        )

    labels = policy.create_labels or policy.update_labels
    if not labels:
        raise WriteNotConfigured(
            "this run is armed to write to TEGG, but no control label is "
            "configured. Set service.write.create_labels in config/service.yaml "
            "to the exact text of the control that saves a report. Nothing was "
            "changed, and nothing was guessed at."
        )

    control, label = _find(page, labels)
    if control is None:
        raise WriteRefused(
            "none of the configured controls "
            f"{list(labels)} is on this page, so nothing was clicked. Either "
            "the portal words it differently -- correct "
            "service.write.create_labels -- or this page is not the one that "
            "creates a report. Nothing was changed."
        )

    note(f"clicking {label!r} to create/update the TEGG report record")
    control.click(timeout=30_000)
    page.wait_for_timeout(4000)
    policy.actions.append(f"clicked {label!r} (create/update report record)")

    for confirm_label in policy.confirm_labels:
        extra, found = _find(page, (confirm_label,))
        if extra is not None:
            note(f"confirming with {found!r}")
            extra.click(timeout=20_000)
            page.wait_for_timeout(3000)
            policy.actions.append(f"clicked {found!r} (confirmation)")

    return {
        "wrote": True,
        "controls": list(policy.actions),
        "url": getattr(page, "url", ""),
    }


__all__ = [
    "CONFIRMATION_PHRASE", "WritePolicy", "WriteRefused", "WriteNotConfigured",
    "confirm", "create_or_update",
]
