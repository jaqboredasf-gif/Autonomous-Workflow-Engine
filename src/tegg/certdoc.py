"""Certificate handling for real portal documents.

The portal serves the certificate as a legacy binary ``.doc`` (Aspose-generated
OLE2), which python-docx cannot open at all. Worse, once converted, its
checkboxes turn out not to be form fields or content controls but literal
Wingdings glyphs in the private-use area -- so the checkbox-editing code in
``certificate.py`` finds nothing to edit.

This module is the safe path around that. It does three things and refuses to
do a fourth:

  1. Preserves the original download byte-for-byte. Nothing here ever writes
     back over a source file.
  2. Converts through LibreOffice in a controlled subprocess, to ``.docx`` for
     inspection and to ``.pdf`` for inclusion in the report.
  3. Classifies how the certificate encodes its checkboxes, and says plainly
     whether automated editing is provably safe.

It does **not** edit a certificate whose control mapping has not been proven.
An ESA certificate is a customer-facing legal attestation; ticking the wrong
box on one is materially worse than making a human tick it by hand. When
editing is not proven safe, the unmodified certificate is carried into the
report and the job is flagged for review.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .certificate import CertificateError, find_soffice

# Wingdings and friends live in the private-use area. 0xF06F is the empty
# ballot box the real TEGG certificate uses; 0xF0FE is its ticked counterpart.
PUA_START = 0xF000
PUA_END = 0xF0FF
WINGDINGS_UNCHECKED = ""
WINGDINGS_CHECKED = ""

# Genuine Unicode ballot boxes, in case a newer template uses them.
UNICODE_UNCHECKED = {"☐"}
UNICODE_CHECKED = {"☒", "☑"}

# Encodings we can detect.
LEGACY_FORM_FIELD = "legacy_form_field"
CONTENT_CONTROL = "content_control"
WINGDINGS_GLYPH = "wingdings_glyph"
UNICODE_SYMBOL = "unicode_symbol"
SHAPE_OR_DRAWING = "shape_or_drawing"
FLATTENED = "flattened"

# Encodings for which an automated edit is proven safe. Deliberately empty of
# the glyph encodings until a mapping is verified against a real signed
# certificate -- see docs/GAPS.md #4.
EDITABLE_ENCODINGS = {LEGACY_FORM_FIELD, CONTENT_CONTROL}


def convert(source: Path, out_dir: Path, target: str = "pdf", timeout: int = 180) -> Path:
    """Convert a document with LibreOffice. Returns the produced file.

    The source is opened read-only and never written back to; the conversion
    happens in a scratch directory and only the result is moved out.
    """
    source = Path(source)
    if not source.exists():
        raise CertificateError(f"certificate not found: {source}")

    soffice = find_soffice()
    if not soffice:
        raise CertificateError(
            "LibreOffice is required to convert the certificate but was not "
            "found. Install it (macOS: brew install --cask libreoffice) or set "
            "TEGG_SOFFICE to its path."
        )

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as staging:
        # LibreOffice needs an explicit writable profile or it silently fails
        # to load anything when HOME is unwritable or a profile is locked.
        profile = Path(staging) / "lo-profile"
        try:
            result = subprocess.run(
                [
                    soffice,
                    f"-env:UserInstallation={profile.as_uri()}",
                    "--headless",
                    "--norestore",
                    "--convert-to",
                    target,
                    "--outdir",
                    staging,
                    str(source),
                ],
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise CertificateError(
                f"LibreOffice timed out after {timeout}s converting {source.name}"
            ) from exc

        produced = Path(staging) / f"{source.stem}.{target}"
        if not produced.exists():
            raise CertificateError(
                f"LibreOffice did not produce a .{target} for {source.name}. "
                f"stderr: {result.stderr.strip()[:400]}"
            )
        destination = out_dir / produced.name
        shutil.move(str(produced), str(destination))
    return destination


def ensure_docx(source: Path, out_dir: Path) -> Path:
    """Return a .docx for ``source``, converting a legacy .doc if needed."""
    source = Path(source)
    if source.suffix.lower() == ".docx":
        return source
    return convert(source, out_dir, target="docx")


@dataclass
class ControlAnalysis:
    """What kind of checkboxes a certificate actually contains."""

    path: Path
    encodings: set[str] = field(default_factory=set)
    counts: dict[str, int] = field(default_factory=dict)
    section_a_index: int | None = None
    section_b_index: int | None = None
    item_lines: list[str] = field(default_factory=list)
    boxes_per_item: int | None = None
    error: str = ""

    @property
    def encoding(self) -> str:
        """The dominant encoding, for reporting."""
        if not self.counts:
            return FLATTENED
        return max(self.counts.items(), key=lambda kv: kv[1])[0]

    @property
    def editable(self) -> bool:
        """Whether an automated edit is proven safe for this document.

        Requires a supported encoding *and* an unambiguous one-box-per-item
        layout. The real certificate fails both.
        """
        if self.error or not self.encodings:
            return False
        if not self.encodings <= EDITABLE_ENCODINGS:
            return False
        return self.boxes_per_item == 1

    def reason(self) -> str:
        """Plain-language explanation of why editing is or is not safe."""
        if self.error:
            return self.error
        if not self.encodings:
            return (
                "no checkboxes of any recognised kind were found; the "
                "certificate may be flattened or image-based"
            )
        unsupported = self.encodings - EDITABLE_ENCODINGS
        if unsupported:
            names = ", ".join(sorted(unsupported))
            return (
                f"checkboxes are encoded as {names}, which cannot be set "
                "programmatically with a proven mapping"
            )
        if self.boxes_per_item not in (None, 1):
            return (
                f"each item carries {self.boxes_per_item} checkboxes (Yes/No "
                "pairs), so item numbering cannot be mapped to a single box"
            )
        return "automated editing is supported for this document"

    def describe(self) -> str:
        lines = [
            f"file                  : {Path(self.path).name}",
            f"encodings found       : {', '.join(sorted(self.encodings)) or '(none)'}",
            f"counts                : {self.counts or '{}'}",
            f"section A paragraph   : {self.section_a_index}",
            f"section B paragraph   : {self.section_b_index}",
            f"numbered items under B: {len(self.item_lines)}",
            f"checkboxes per item   : {self.boxes_per_item}",
            f"safe to edit          : {'yes' if self.editable else 'NO'}",
            f"reason                : {self.reason()}",
        ]
        if self.item_lines:
            lines += ["", "items under B:"]
            lines += [f"  {line[:74]}" for line in self.item_lines]
        return "\n".join(lines)


def analyze(docx_path: Path) -> ControlAnalysis:
    """Classify how a .docx certificate encodes its checkboxes.

    Read-only. Never modifies the document.
    """
    from docx import Document
    from docx.oxml.ns import qn

    docx_path = Path(docx_path)
    analysis = ControlAnalysis(path=docx_path)

    if docx_path.suffix.lower() != ".docx":
        analysis.error = (
            f"{docx_path.name} is not a .docx. Convert the legacy .doc first "
            "(tegg certificate-inspect does this automatically)."
        )
        return analysis

    try:
        document = Document(str(docx_path))
    except Exception as exc:
        analysis.error = f"could not open {docx_path.name}: {exc}"
        return analysis

    counts: dict[str, int] = {}

    def bump(kind: str, amount: int = 1) -> None:
        if amount:
            counts[kind] = counts.get(kind, 0) + amount
            analysis.encodings.add(kind)

    item_box_counts: list[int] = []

    for index, paragraph in enumerate(document.paragraphs):
        text = paragraph.text.strip()
        if analysis.section_a_index is None and text.startswith("A."):
            analysis.section_a_index = index
        if analysis.section_b_index is None and text.startswith("B."):
            analysis.section_b_index = index

        element = paragraph._p
        legacy = len(element.findall(f".//{qn('w:checkBox')}"))
        bump(LEGACY_FORM_FIELD, legacy)
        controls = sum(
            1
            for sdt in element.findall(f".//{qn('w:sdt')}")
            if sdt.findall(".//{*}checkbox")
        )
        bump(CONTENT_CONTROL, controls)
        bump(SHAPE_OR_DRAWING, len(element.findall(f".//{qn('w:drawing')}")))
        bump(SHAPE_OR_DRAWING, len(element.findall(f".//{qn('w:pict')}")))

        pua = sum(1 for ch in text if PUA_START <= ord(ch) <= PUA_END)
        bump(WINGDINGS_GLYPH, pua)
        symbols = sum(
            1 for ch in text if ch in UNICODE_UNCHECKED or ch in UNICODE_CHECKED
        )
        bump(UNICODE_SYMBOL, symbols)

        # A numbered item under B, e.g. "(3)  Energized System ...".
        if (
            analysis.section_b_index is not None
            and index > analysis.section_b_index
            and text.startswith("(")
        ):
            analysis.item_lines.append(text)
            # Every encoding counts here: what matters for the numbering is how
            # many boxes one item carries, not how they happen to be stored.
            boxes = legacy + controls + pua + symbols
            if boxes:
                item_box_counts.append(boxes)

    analysis.counts = counts
    if item_box_counts:
        # If every item agrees, that count is the layout. Disagreement means
        # the layout is not uniform and must not be assumed.
        unique = set(item_box_counts)
        analysis.boxes_per_item = unique.pop() if len(unique) == 1 else None
    return analysis


@dataclass
class CertificateOutcome:
    """What the certificate stage produced, and whether a human must look."""

    original: Path
    pdf: Path | None = None
    docx: Path | None = None
    analysis: ControlAnalysis | None = None
    edited: bool = False
    review_required: bool = True
    reason: str = ""

    def describe(self) -> str:
        lines = [f"certificate  original : {Path(self.original).name}"]
        if self.docx:
            lines.append(f"             docx     : {Path(self.docx).name}")
        if self.pdf:
            lines.append(f"             pdf      : {Path(self.pdf).name}")
        lines.append(f"             edited   : {'yes' if self.edited else 'no'}")
        if self.review_required:
            lines.append(f"             REVIEW   : {self.reason}")
        return "\n".join(lines)


def prepare(
    source: Path,
    work_dir: Path,
    output_pdf_name: str = "Certificates good.pdf",
) -> CertificateOutcome:
    """Take a downloaded certificate to a PDF fit for the report.

    Converts, inspects, and -- only if the control mapping is proven safe --
    would apply the SOP's edits. Today no real certificate meets that bar, so
    the unmodified document is carried through and the job is flagged.
    """
    source = Path(source)
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    outcome = CertificateOutcome(original=source)

    # Inspect via a .docx copy. The original is never touched.
    try:
        outcome.docx = ensure_docx(source, work_dir)
        outcome.analysis = analyze(outcome.docx)
    except CertificateError as exc:
        outcome.analysis = ControlAnalysis(path=source, error=str(exc))

    analysis = outcome.analysis
    if analysis is not None and analysis.editable:
        # Reserved for when a mapping is proven. Falling through to the
        # unedited path is always the safe default.
        outcome.reason = "editing supported but not yet enabled; verify first"
    else:
        outcome.reason = (
            "certificate checkboxes were not edited automatically: "
            + (analysis.reason() if analysis else "inspection failed")
            + ". Tick section B by hand before sending."
        )

    outcome.edited = False
    outcome.review_required = True

    # The PDF for the report comes from the original document, so nothing the
    # inspection did can affect what the customer receives.
    outcome.pdf = convert(source, work_dir, target="pdf")
    target = work_dir / output_pdf_name
    if outcome.pdf.resolve() != target.resolve():
        shutil.move(str(outcome.pdf), str(target))
        outcome.pdf = target
    return outcome
