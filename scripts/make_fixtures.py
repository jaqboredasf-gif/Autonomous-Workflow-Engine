"""Generate stand-in PDFs so the assembly stage can be demoed without portal access.

    python scripts/make_fixtures.py <output_dir>

Each generated file has a distinct page count and every page is stamped with
its document name and page number, so the merged result can be checked by eye.
"""

from __future__ import annotations

import sys
from pathlib import Path

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

# name -> page count, chosen to look like a plausible real job.
FIXTURES = {
    "StandardIRReport.pdf": 9,
    "ESA Table of Contents.pdf": 1,
    "Certificates good.pdf": 2,
    "ProblemCountSummary.pdf": 2,
    "EquipmentInventoryShortForm.pdf": 5,
    "EquipmentInventoryLongForm.pdf": 12,
    "EquipmentItemProblem_AllImages.pdf": 7,
    "EDSAllProblemsOnly.pdf": 4,
    "TEGGPro View Customer Instructions.pdf": 2,
}


def make_pdf(path: Path, title: str, pages: int) -> None:
    pdf = canvas.Canvas(str(path), pagesize=LETTER)
    width, height = LETTER
    for page in range(1, pages + 1):
        pdf.setFont("Helvetica-Bold", 22)
        pdf.drawCentredString(width / 2, height - 2.5 * inch, title)
        pdf.setFont("Helvetica", 13)
        pdf.drawCentredString(
            width / 2, height - 3.1 * inch, f"page {page} of {pages}"
        )
        if title == "StandardIRReport.pdf" and page == 1:
            pdf.setFont("Helvetica-Oblique", 11)
            pdf.drawCentredString(
                width / 2, height - 3.7 * inch,
                "(this page becomes Cover.pdf)",
            )
        pdf.showPage()
    pdf.save()


def main() -> int:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, pages in FIXTURES.items():
        make_pdf(out_dir / name, name, pages)
    print(f"wrote {len(FIXTURES)} fixture PDFs to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
