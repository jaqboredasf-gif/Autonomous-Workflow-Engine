"""What the operator is asked, before anything touches the portal.

The Windows mock run failed for a reason that is not a bug in any one function:
nothing ever asked the operator anything. ``Run Report.bat`` went straight to
``run visit-findings``, the site details were whatever the portal's visit row
happened to say, and the recipient of the finished work had no representation
anywhere in the system. A report that nobody was asked about is a report
nobody can be accountable for.

So this module is the front door, and it holds to these rules:

  * **Nothing is guessed.** Every field a report needs is asked for by number,
    with an example of what a good answer looks like.
  * **Blank is not an answer.** A required field re-asks rather than accepting
    an empty string, because an empty customer name reaches the email subject
    line and the operator does not find out until the customer does.
  * **The operator confirms before the browser opens.** The summary screen
    lists every answer by number; any number revises that one field; nothing
    proceeds until they say so.
  * **Cancelling is safe and always available.** Ctrl-C, EOF, or ``C`` at the
    confirmation exits before a single portal action, and says so.
  * **No credential is ever collected here.** Sign-in is read from the
    environment at the moment it is typed into the form. A password asked for
    on this screen would end up in the answers dict, in the ledger, and in the
    run folder -- so it is not asked for on this screen.

The wizard is driven through injected ``ask``/``say`` callables rather than
``input``/``print`` so the tests can drive it as a real operator would, one
keystroke at a time, without a terminal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

#: How the operator answers "where do the findings come from".
FROM_TEGG = "retrieve"
FROM_OPERATOR = "supplement"

#: A recipient address has to survive being handed to a mail client. This is
#: deliberately permissive about the local part and strict about the shape --
#: it is here to catch "paul" and "paul@", not to adjudicate RFC 5322.
_EMAIL = re.compile(r"^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$")

#: A TEGG visit identifier as the portal writes them: ``T25-204``, ``71999``,
#: ``T26-PAUL``. Letters, digits and dashes, at least three characters. Loose
#: on purpose: the authority on whether a visit exists is the portal, and this
#: only catches a slipped keystroke before a browser is opened for nothing.
_VISIT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-_/]{2,}$")


class IntakeCancelled(Exception):
    """The operator chose to stop. Nothing has been done and nothing is owed."""


def _clean(value: str) -> str:
    return " ".join((value or "").split())


# ---------------------------------------------------------------------------
# Validators. Each returns an error sentence, or "" when the answer is good.
# ---------------------------------------------------------------------------


def _valid_email(value: str) -> str:
    if not _EMAIL.match(value):
        return (
            f"{value!r} does not look like an email address. It needs an @ and "
            "a domain, for example paul.lippolis@example.com"
        )
    return ""


def _valid_visit(value: str) -> str:
    if not _VISIT_ID.match(value):
        return (
            f"{value!r} does not look like a TEGG visit ID. They look like "
            "T25-204 or 71999 -- letters, digits and dashes."
        )
    return ""


def _valid_choice(options: dict[str, str]) -> Callable[[str], str]:
    def check(value: str) -> str:
        if value.strip().lower() in options:
            return ""
        return (
            f"{value!r} is not one of the choices. Type "
            + " or ".join(sorted(options)) + "."
        )

    return check


#: The two evidence paths, as the operator is offered them.
EVIDENCE_CHOICES = {
    "1": FROM_TEGG,
    "2": FROM_OPERATOR,
    "r": FROM_TEGG,
    "s": FROM_OPERATOR,
}


@dataclass
class Field:
    """One question, and everything needed to ask it well."""

    key: str
    prompt: str
    example: str = ""
    required: bool = True
    validator: Callable[[str], str] | None = None
    note: str = ""
    #: A field the operator picks from a list rather than types freely.
    choices: tuple[tuple[str, str], ...] = ()


#: Every question, in the order the operator is asked. The numbering the
#: operator sees is this list's order, so inserting a field renumbers the
#: screen -- which is why the confirmation screen renders from this list too,
#: rather than from a second hard-coded list that could drift out of step.
FIELDS: tuple[Field, ...] = (
    Field(
        key="site_visit",
        prompt="TEGG visit ID",
        example="T25-204",
        validator=_valid_visit,
        note="On the visit in TEGG Documentation. This is what gets read.",
    ),
    Field(
        key="customer",
        prompt="Customer / company name",
        example="Atlas Capital",
        note="As it should appear on the report and in the email.",
    ),
    Field(
        key="site",
        prompt="Site name",
        example="The Factory",
    ),
    Field(
        key="site_address",
        prompt="Site address",
        example="120 Mill Street, Toledo OH 43604",
    ),
    Field(
        key="recipient_name",
        prompt="Report recipient's name",
        example="Paul Lippolis",
        note="Who the email draft is addressed to.",
    ),
    Field(
        key="recipient_email",
        prompt="Report recipient's email",
        example="paul.lippolis@example.com",
        validator=_valid_email,
    ),
    Field(
        key="job_number",
        prompt="Job / reference number",
        example="T25-204-ESA",
        note="Your own reference. It goes in the email subject and the manifest.",
    ),
    Field(
        key="report_scope",
        prompt="Reports wanted",
        example="the full standard package",
        required=False,
        note="Leave blank for the standard package.\n"
             "Anything typed here is recorded and shown to whoever "
             "reviews the draft.",
    ),
    Field(
        key="evidence_path",
        prompt="Findings source",
        choices=(
            ("1", "Retrieve the visit and its findings from TEGG (normal)"),
            ("2", "Retrieve, then let me review and add missing detail"),
        ),
        validator=_valid_choice(EVIDENCE_CHOICES),
        example="1",
    ),
)

#: Width of the prompt column on the confirmation screen. Derived rather than
#: guessed, so adding a longer field cannot silently break the alignment.
_PROMPT_WIDTH = max(len(f.prompt) for f in FIELDS) + 2


@dataclass
class Intake:
    """The operator's answers. Carries no credential, and never will."""

    site_visit: str = ""
    customer: str = ""
    site: str = ""
    site_address: str = ""
    recipient_name: str = ""
    recipient_email: str = ""
    job_number: str = ""
    report_scope: str = ""
    evidence_path: str = FROM_TEGG
    #: Anything the operator added at the review step of the second path.
    operator_notes: str = ""
    answers: dict[str, str] = field(default_factory=dict)

    @property
    def supplementing(self) -> bool:
        return self.evidence_path == FROM_OPERATOR

    def to_dict(self) -> dict[str, Any]:
        return {
            "site_visit": self.site_visit,
            "customer": self.customer,
            "site": self.site,
            "site_address": self.site_address,
            "recipient_name": self.recipient_name,
            "recipient_email": self.recipient_email,
            "job_number": self.job_number,
            "report_scope": self.report_scope or "the standard TEGG ESA package",
            "evidence_path": self.evidence_path,
            "operator_notes": self.operator_notes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Intake":
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in (data or {}).items()
                      if k in known and k != "answers"})


# ---------------------------------------------------------------------------
# Asking
# ---------------------------------------------------------------------------


def _ask_one(
    question: Field,
    ask: Callable[[str], str],
    say: Callable[[str], None],
    number: int,
    total: int,
    current: str = "",
) -> str:
    """Ask one question until the answer is usable, or the operator gives up.

    Re-asks rather than failing: an operator who typed a blank line by accident
    should not lose the eight answers they already gave.
    """
    while True:
        say("")
        say(f"  [{number} of {total}]  {question.prompt}")
        for line in question.note.splitlines():
            say(f"           {line}")
        for value, label in question.choices:
            say(f"             {value}) {label}")
        if question.example and not question.choices:
            say(f"           example: {question.example}")
        if current:
            say(f"           current: {current}")
        if not question.required:
            say("           (optional -- press Enter to skip)")

        raw = _clean(ask("  > "))

        if not raw and current:
            return current
        if not raw:
            if not question.required:
                return ""
            say("           ! This one is needed. Nothing can be produced "
                "without it.")
            continue
        if question.validator:
            problem = question.validator(raw)
            if problem:
                say(f"           ! {problem}")
                continue
        if question.choices:
            return EVIDENCE_CHOICES[raw.lower()]
        return raw


def _summary_lines(intake: Intake, fields: Iterable[Field]) -> list[str]:
    lines = []
    for number, question in enumerate(fields, start=1):
        value = getattr(intake, question.key, "")
        if question.key == "evidence_path":
            value = ("retrieve findings from TEGG" if value == FROM_TEGG
                     else "retrieve, then review and supplement")
        elif question.key == "report_scope" and not value:
            value = "the standard TEGG ESA package"
        lines.append(
            f"   {number:>2}. {question.prompt:<{_PROMPT_WIDTH}} "
            f"{value or '(not given)'}"
        )
    return lines


def collect(
    ask: Callable[[str], str],
    say: Callable[[str], None],
    *,
    prefill: dict[str, Any] | None = None,
    fields: tuple[Field, ...] = FIELDS,
) -> Intake:
    """Run the wizard. Returns the confirmed answers, or raises IntakeCancelled.

    ``prefill`` re-seeds a rerun so an operator resuming a failed run is not
    made to retype nine answers to get back to where they were.
    """
    intake = Intake.from_dict(prefill or {})

    say("")
    say("=" * 68)
    say("  TEGG REPORT -- what this report is about")
    say("=" * 68)
    say("")
    say("  Nine questions. Nothing is sent to TEGG until you confirm them.")
    say("  Press Ctrl-C at any point to stop; nothing will have been done.")
    say("")
    say("  Your TEGG sign-in is NOT asked for here and is never saved by this")
    say("  tool. It is read from this window only while signing in.")

    total = len(fields)
    try:
        for number, question in enumerate(fields, start=1):
            answer = _ask_one(
                question, ask, say, number, total,
                current=str(getattr(intake, question.key, "") or ""),
            )
            setattr(intake, question.key, answer)

        while True:
            say("")
            say("-" * 68)
            say("  CONFIRM -- this is what the report will be built from")
            say("-" * 68)
            for line in _summary_lines(intake, fields):
                say(line)
            say("")
            say("   Enter Y to start, a number (1-%d) to change that answer," % total)
            say("   or C to cancel without doing anything.")
            choice = _clean(ask("  > ")).lower()

            if choice in {"y", "yes"}:
                intake.answers = intake.to_dict()
                say("")
                say("  Confirmed. Starting.")
                return intake
            if choice in {"c", "cancel", "n", "no", "q", "quit"}:
                raise IntakeCancelled(
                    "cancelled at the confirmation screen; nothing was sent to "
                    "TEGG and nothing was written"
                )
            if choice.isdigit() and 1 <= int(choice) <= total:
                question = fields[int(choice) - 1]
                setattr(
                    intake, question.key,
                    _ask_one(question, ask, say, int(choice), total,
                             current=str(getattr(intake, question.key, "") or "")),
                )
                continue
            say(f"  ! {choice!r} is not Y, C, or a number between 1 and {total}.")

    except (KeyboardInterrupt, EOFError) as stop:
        raise IntakeCancelled(
            "cancelled before anything was done; no report was created, no "
            "email was drafted and nothing in TEGG was touched"
        ) from stop


def review_supplement(
    intake: Intake,
    ask: Callable[[str], str],
    say: Callable[[str], None],
    *,
    findings_summary: str = "",
) -> Intake:
    """The second evidence path: show what came back, invite additions.

    Only reached when the operator chose that path. It cannot change a finding
    -- findings are what the reports say -- but what the operator adds travels
    into the review page and the email draft, attributed to them.
    """
    if not intake.supplementing:
        return intake
    say("")
    say("-" * 68)
    say("  REVIEW -- what came back from TEGG")
    say("-" * 68)
    for line in (findings_summary or "(nothing summarised)").splitlines():
        say(f"   {line}")
    say("")
    say("  Anything to add for whoever reviews this? Press Enter for nothing.")
    try:
        extra = _clean(ask("  > "))
    except (KeyboardInterrupt, EOFError) as stop:
        raise IntakeCancelled("cancelled at the review step") from stop
    if extra:
        intake.operator_notes = extra
        intake.answers = intake.to_dict()
        say("  Recorded, and attributed to you in the review page.")
    return intake


__all__ = [
    "FIELDS", "FROM_TEGG", "FROM_OPERATOR", "Field", "Intake",
    "IntakeCancelled", "collect", "review_supplement",
]
