"""The email a person reviews and sends. This module never sends it.

There is no ``smtplib`` import in this file, no socket, no transport, no
credential and no send function -- not as a disabled flag or a guarded branch,
but absent. A flag that defaults to off is one edit away from being on; code
that cannot send cannot be made to send by accident. The tests assert this by
reading the module's own source.

What it produces, for one finished run:

  * ``draft.eml`` -- a standard RFC 5322 message with every document
    attached. Double-clicking it opens Outlook with the message ready, To:
    filled in, attachments in place, and nothing sent.
  * ``attachments/`` -- the same files, copied. This is the fallback for
    when the mail client will not take an ``.eml``, and it exists always
    rather than only on failure, because the operator finding out which case
    they are in should not require them to already know.
  * ``HOW TO SEND.txt`` -- what to do with the two things above, in order.

The subject carries the customer and site, because an operator with six of
these open needs to tell them apart, and the recipient needs to know what
arrived before opening it.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path
from typing import Any

DRAFT_NAME = "draft.eml"
STAGING_DIR = "attachments"
INSTRUCTIONS_NAME = "HOW TO SEND.txt"

#: Stamped into the message and the instructions. A draft that does not say it
#: is a draft is a sent email waiting to happen.
BANNER = "DRAFT FOR REVIEW -- NOT SENT"

#: Attachment types this run produces.
_MIME = {
    ".pdf": ("application", "pdf"),
    ".md": ("text", "markdown"),
    ".json": ("application", "json"),
    ".txt": ("text", "plain"),
}


@dataclass
class Draft:
    """One reviewable message. Holds no transport and no credential."""

    to_name: str = ""
    to_email: str = ""
    subject: str = ""
    body: str = ""
    attachments: list[Path] = field(default_factory=list)
    #: Set once written, so the operator display can name it.
    path: Path | None = None
    staged: list[Path] = field(default_factory=list)
    attached_ok: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "to_name": self.to_name,
            "to_email": self.to_email,
            "subject": self.subject,
            "attachments": [p.name for p in self.attachments],
            "attached_into_message": self.attached_ok,
            "path": str(self.path) if self.path else "",
            "staging_folder": str(self.staged[0].parent) if self.staged else "",
            "sent": False,
            "sendable_by_this_tool": False,
        }


def subject_for(customer: str, site: str, job_number: str = "", year: str = "") -> str:
    """A subject line somebody can find again in six months."""
    where = " - ".join(part for part in (customer.strip(), site.strip()) if part)
    where = where or "TEGG site"
    tail = f" [{job_number.strip()}]" if job_number.strip() else ""
    when = f" {year}" if year else ""
    return f"TEGG ESA Report{when} - {where}{tail}"


def body_for(
    intake: Any,
    filenames: list[str],
    *,
    review_note: str = "",
    operator_notes: str = "",
) -> str:
    """The message text. Professional, short, and honest about its status."""
    greeting = (intake.recipient_name or "").split(" ")[0] or "there"
    site_line = intake.site or ""
    if intake.site_address:
        site_line = f"{site_line}, {intake.site_address}".strip(", ")

    lines = [
        f"Hi {greeting},",
        "",
        f"Please find attached the TEGG electrical system assessment report "
        f"package for {intake.customer or 'your site'}"
        + (f" at {site_line}" if site_line else "")
        + ".",
        "",
        f"Site visit: {intake.site_visit}",
    ]
    if intake.job_number:
        lines.append(f"Job reference: {intake.job_number}")
    lines += [
        "",
        f"The package contains {len(filenames)} documents:",
        "",
    ]
    lines += [f"  {n}. {name}" for n, name in enumerate(filenames, start=1)]
    lines += [
        "",
        "Please let us know if you have any questions about the findings or "
        "would like to discuss the recommended work.",
        "",
        "Kind regards",
        "",
    ]
    if operator_notes:
        lines += [f"Note added by the operator: {operator_notes}", ""]
    if review_note:
        lines += ["--", review_note, ""]
    return "\n".join(lines)


def build(
    intake: Any,
    manifest: Any,
    *,
    review_note: str = "",
    year: str = "",
) -> Draft:
    """Compose the draft from the confirmed intake and the finished manifest.

    The manifest is required to be complete before this is called -- there is
    no path that drafts an email about a short package.
    """
    manifest.enforce()
    filenames = manifest.filenames()
    return Draft(
        to_name=intake.recipient_name,
        to_email=intake.recipient_email,
        subject=subject_for(intake.customer, intake.site, intake.job_number, year),
        body=body_for(
            intake, filenames,
            review_note=review_note,
            operator_notes=getattr(intake, "operator_notes", ""),
        ),
        attachments=list(manifest.paths()),
    )


def _attach(message: EmailMessage, path: Path) -> None:
    maintype, subtype = _MIME.get(path.suffix.lower(), ("application", "octet-stream"))
    message.add_attachment(
        path.read_bytes(),
        maintype=maintype,
        subtype=subtype,
        filename=path.name,
    )


def write(draft: Draft, directory: Path | str) -> Draft:
    """Write the draft, its staged attachments and its instructions.

    Attachment failure is not draft failure: a message that could not carry a
    170 MB PDF is still worth having, with the file beside it and a sentence
    saying so.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    message = EmailMessage()
    message["To"] = (formataddr((draft.to_name, draft.to_email))
                     if draft.to_name else draft.to_email)
    message["Subject"] = draft.subject
    message["X-TEGG-Status"] = BANNER
    message["X-Unsent"] = "1"          # Outlook opens this as a composable draft
    message.set_content(draft.body)

    attached = True
    for path in draft.attachments:
        try:
            _attach(message, Path(path))
        except (OSError, MemoryError):
            attached = False
    draft.attached_ok = attached and bool(draft.attachments)

    target = directory / DRAFT_NAME
    target.write_bytes(bytes(message))
    draft.path = target

    staging = directory / STAGING_DIR
    staging.mkdir(parents=True, exist_ok=True)
    staged: list[Path] = []
    for path in draft.attachments:
        path = Path(path)
        if not path.exists():
            continue
        copy = staging / path.name
        shutil.copy2(path, copy)
        staged.append(copy)
    draft.staged = staged

    (directory / INSTRUCTIONS_NAME).write_text(
        _instructions(draft, staging), encoding="utf-8"
    )
    return draft


def _instructions(draft: Draft, staging: Path) -> str:
    listing = "\n".join(f"    {n}. {p.name}" for n, p in
                        enumerate(draft.staged or draft.attachments, start=1))
    attached_line = (
        "All documents are already attached to the message."
        if draft.attached_ok else
        "The documents could NOT be attached automatically -- attach them by "
        "hand from the folder below."
    )
    return f"""{BANNER}
{'=' * len(BANNER)}

This tool has NOT sent anything. Nothing leaves this PC until you send it.

To send:

  1. Double-click        {DRAFT_NAME}
     It opens in Outlook as an unsent message, addressed to
     {draft.to_email}.

  2. {attached_line}

  3. Read it. Check the recipient, the site and the documents.

  4. Press Send yourself.

The documents, also kept as loose files in case step 1 does not work on this
PC:

    {staging}

{listing}

If Outlook will not open {DRAFT_NAME}: start a new email yourself, paste the
subject and body from {DRAFT_NAME} (it opens in Notepad), and drag the files
from the folder above into it.

Subject:
    {draft.subject}
"""


__all__ = [
    "BANNER", "DRAFT_NAME", "STAGING_DIR", "INSTRUCTIONS_NAME",
    "Draft", "build", "body_for", "subject_for", "write",
]
