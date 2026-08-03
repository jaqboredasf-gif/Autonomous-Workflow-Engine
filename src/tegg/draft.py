"""DRAFT / HUMAN REVIEW REQUIRED labelling for a first-run report.

Three layers, each independently safe:

  1. The output filename carries a ``DRAFT - `` prefix.
  2. The PDF's Title metadata says so.
  3. A diagonal watermark is stamped on every page, if reportlab is available.

The watermark is an *overlay*, so the page count is unchanged and the invariant
"final page count equals the sum of the components" still holds. If reportlab
is missing the stamp is skipped and the report is produced unwatermarked rather
than not at all -- a missing watermark is a nuisance, a failed build on report
day is not.
"""

from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader, PdfWriter

BANNER = "DRAFT - HUMAN REVIEW REQUIRED"
FILENAME_PREFIX = "DRAFT - "


def draft_filename(name: str) -> str:
    """Prefix a report filename to mark it as a draft."""
    return name if name.startswith(FILENAME_PREFIX) else f"{FILENAME_PREFIX}{name}"


def watermark_available() -> bool:
    try:
        import reportlab  # noqa: F401

        return True
    except ImportError:
        return False


def _overlay(width: float, height: float, text: str):
    """A single transparent page carrying the diagonal watermark."""
    import io

    from reportlab.lib.colors import Color
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(width, height))
    pdf.saveState()
    pdf.setFillColor(Color(0.85, 0.1, 0.1, alpha=0.16))
    pdf.setFont("Helvetica-Bold", max(28, min(width, height) / 15))
    pdf.translate(width / 2, height / 2)
    pdf.rotate(45)
    pdf.drawCentredString(0, 0, text)
    pdf.restoreState()

    # A small, always-legible note in the corner, in case the diagonal stamp
    # is lost to a printer's margins.
    pdf.setFillColor(Color(0.7, 0.1, 0.1, alpha=0.75))
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(18, 14, text)
    pdf.showPage()
    pdf.save()
    buffer.seek(0)
    return PdfReader(buffer).pages[0]


def apply(source: Path, output: Path, text: str = BANNER) -> tuple[Path, bool]:
    """Write ``source`` to ``output`` with the draft markings applied.

    Returns the path written and whether the visual watermark was stamped.
    """
    source = Path(source)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Clone into the writer first: pypdf requires a page to belong to a writer
    # before it can be merged onto, and doing it the other way round is
    # deprecated and unreliable.
    writer = PdfWriter(clone_from=str(source))
    stamped = False

    can_stamp = watermark_available()
    for page in writer.pages:
        if not can_stamp:
            break
        try:
            box = page.mediabox
            overlay = _overlay(float(box.width), float(box.height), text)
            page.merge_page(overlay)
            stamped = True
        except Exception:
            # Never let a cosmetic failure damage the report.
            can_stamp = False

    writer.add_metadata(
        {
            "/Title": f"{text} - ESA Report",
            "/Producer": "tegg",
            "/Subject": text,
        }
    )
    with output.open("wb") as handle:
        writer.write(handle)
    return output, stamped
