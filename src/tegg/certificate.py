"""Certificate editing: Certificates.docx -> Certificates good.pdf.

Automates the SOP steps:

  * delete the first group of checkboxes
  * enter the current date under A.
  * under B., check Yes for (1)(2)(3)(4)(5)(9) and No for (6)(7)(8)(10)
  * save as "Certificates good.pdf"

IMPORTANT -- Word documents encode checkboxes in three different ways and the
right one cannot be guessed without a real Certificates.docx in hand. All three
are handled below, but the selectors have NOT been validated against a live
file. See docs/GAPS.md -> "Certificate document structure".
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

# The three ways a checkbox shows up in a .docx.
CHECKED_GLYPHS = {"☒", "☑", "þ"}   # ballot-x, check-in-box, Wingdings check
UNCHECKED_GLYPHS = {"☐", "¨"}           # empty ballot box, Wingdings empty


class CertificateError(Exception):
    """Raised when the certificate cannot be edited as the SOP describes."""


@dataclass
class CertificateEdit:
    """A record of what was changed, for the run log and for verification."""

    date_written: str
    boxes_checked: list[int]
    boxes_unchecked: list[int]
    groups_deleted: int

    def summary(self) -> str:
        return (
            f"date={self.date_written} "
            f"yes={self.boxes_checked} no={self.boxes_unchecked} "
            f"deleted_groups={self.groups_deleted}"
        )


def _legacy_checkboxes(document: Document) -> list:
    """Word 97-2003 form-field checkboxes (<w:checkBox>)."""
    return document.element.body.findall(f".//{qn('w:checkBox')}")


def _content_control_checkboxes(document: Document) -> list:
    """Modern content-control checkboxes (<w:sdt> containing a w14:checkbox)."""
    found = []
    for sdt in document.element.body.findall(f".//{qn('w:sdt')}"):
        if sdt.findall(".//{*}checkbox"):
            found.append(sdt)
    return found


def set_legacy_checkbox(element, checked: bool) -> None:
    """Set the <w:default>/<w:checked> value of a legacy form checkbox."""
    for tag in ("w:checked", "w:default"):
        node = element.find(qn(tag))
        if node is not None:
            node.set(qn("w:val"), "1" if checked else "0")
            return
    # Neither node present: Word treats a bare <w:checkBox> as unchecked, so a
    # <w:checked> element has to be added to tick it.
    from docx.oxml import OxmlElement

    node = OxmlElement("w:checked")
    node.set(qn("w:val"), "1" if checked else "0")
    element.append(node)


def edit_certificate(
    source: Path,
    output_docx: Path,
    *,
    yes_items: list[int],
    no_items: list[int],
    when: date | None = None,
    delete_first_group: bool = True,
) -> CertificateEdit:
    """Apply the SOP's certificate edits and save an edited .docx."""
    source = Path(source)
    if not source.exists():
        raise CertificateError(f"certificate not found: {source}")

    document = Document(str(source))
    stamp = (when or date.today()).strftime("%m/%d/%Y")

    legacy = _legacy_checkboxes(document)
    modern = _content_control_checkboxes(document)
    if not legacy and not modern:
        raise CertificateError(
            f"{source.name}: no form checkboxes found. The certificate may use "
            "literal ballot-box characters instead, which needs a real sample "
            "to map. See docs/GAPS.md."
        )

    boxes = legacy or modern
    groups_deleted = 0

    # "Delete first group of checkboxes." Without a real file we cannot know how
    # many boxes are in that first group, so refuse rather than silently guess.
    if delete_first_group:
        raise CertificateError(
            "delete_first_group is enabled but the size of the first checkbox "
            "group is unknown. Provide a sample Certificates.docx so the group "
            "boundary can be pinned down. See docs/GAPS.md -> "
            "'Certificate document structure'."
        )

    highest = max(yes_items + no_items)
    if len(boxes) < highest:
        raise CertificateError(
            f"{source.name}: found {len(boxes)} checkboxes but the SOP "
            f"references item ({highest})"
        )

    for item in yes_items:
        set_legacy_checkbox(boxes[item - 1], True)
    for item in no_items:
        set_legacy_checkbox(boxes[item - 1], False)

    _write_date(document, stamp)

    output_docx = Path(output_docx)
    output_docx.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(output_docx))

    return CertificateEdit(
        date_written=stamp,
        boxes_checked=sorted(yes_items),
        boxes_unchecked=sorted(no_items),
        groups_deleted=groups_deleted,
    )


def _write_date(document: Document, stamp: str) -> None:
    """Put the run date into the section A date placeholder."""
    for paragraph in document.paragraphs:
        if paragraph.text.strip().startswith("A."):
            paragraph.add_run(f"  {stamp}")
            return
    raise CertificateError(
        "could not find a paragraph beginning with 'A.' to place the date"
    )


def docx_to_pdf(source: Path, output_pdf: Path, timeout: int = 180) -> Path:
    """Convert a .docx to PDF using headless LibreOffice."""
    source = Path(source)
    output_pdf = Path(output_pdf)
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise CertificateError(
            "LibreOffice is required to convert the certificate to PDF but was "
            "not found on PATH."
        )

    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as staging:
        try:
            result = subprocess.run(
                [
                    soffice, "--headless", "--norestore",
                    "--convert-to", "pdf", "--outdir", staging, str(source),
                ],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise CertificateError(
                f"LibreOffice timed out after {timeout}s converting {source.name}"
            ) from exc

        produced = Path(staging) / (source.stem + ".pdf")
        if not produced.exists():
            raise CertificateError(
                f"LibreOffice did not produce a PDF for {source.name}. "
                f"stderr: {result.stderr.strip()[:400]}"
            )
        shutil.move(str(produced), str(output_pdf))

    return output_pdf
